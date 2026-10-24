#!/usr/bin/env python3
# =============================================================================
# HYDRA-UMC-SERVER - scripts/ble_gatt_helper.py
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
#
# The radio side of the Bluetooth LE service of the server (docs/BLE_GATT.md): it registers the HYDRA-UMC GATT
# application and an advertisement with BlueZ over D-Bus and speaks JSON lines with the server on stdin and
# stdout. It decides nothing: every frame a phone writes goes to the server, and every frame the server gives
# is notified. Logs go to stderr.
#
# Needs BlueZ and, on Debian, the packages python3-dbus and python3-gi. `--simulate` runs without D-Bus: there
# is no radio, the helper only answers the lines of the server (used by the checks of the server).
#
# Lines from the helper:  {"event":"ready"} {"event":"error","message":...}
#   {"event":"write","link":...,"frame":<base64>}  {"event":"subscribe","link":...,"uuid":...,"on":true|false}
#   {"event":"mtu","mtu":N}
# Lines to the helper:    {"op":"notify","uuid":...,"frame":<base64>}  {"op":"stop"}
from __future__ import annotations

import argparse
import base64
import json
import sys
from typing import Callable

SERVICE_UUID = "48594452-0001-4000-8000-554d43000001"
STATE_UUID = "48594452-0002-4000-8000-554d43000001"
COMMAND_UUID = "48594452-0003-4000-8000-554d43000001"
ACK_UUID = "48594452-0004-4000-8000-554d43000001"

DEFAULT_MTU = 23
MAX_MTU = 517


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"[ble-helper] {message}\n")
    sys.stderr.flush()


def clamp_mtu(value: object) -> int:
    try:
        mtu = int(value)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return DEFAULT_MTU
    return max(DEFAULT_MTU, min(MAX_MTU, mtu))


class MtuTracker:
    """The smallest MTU among the centrals seen: a notification goes to all of them in the same frames."""

    def __init__(self, announce: Callable[[int], None]) -> None:
        self._by_link: dict[str, int] = {}
        self._announced = DEFAULT_MTU
        self._announce = announce

    def seen(self, link: str, mtu: object) -> None:
        self._by_link[link] = clamp_mtu(mtu)
        self._update()

    def gone(self, link: str) -> None:
        self._by_link.pop(link, None)
        self._update()

    def current(self) -> int:
        return min(self._by_link.values()) if self._by_link else DEFAULT_MTU

    def _update(self) -> None:
        mtu = self.current()
        if mtu != self._announced:
            self._announced = mtu
            self._announce(mtu)


def characteristic_flags(uuid: str, require_encryption: bool) -> list[str]:
    if uuid == STATE_UUID:
        return ["read", "notify"] + (["encrypt-read"] if require_encryption else [])
    if uuid == ACK_UUID:
        return ["notify"] + (["encrypt-read"] if require_encryption else [])
    return ["write"] + (["encrypt-write"] if require_encryption else [])


def parse_line(line: str) -> dict | None:
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def run_simulated() -> int:
    """No radio: ready at once, and every notify line is answered with nothing. A line {"op":"stop"} ends it."""
    emit({"event": "ready"})
    for raw in sys.stdin:
        message = parse_line(raw)
        if message is None:
            continue
        if message.get("op") == "stop":
            break
        if message.get("op") == "simulate-write":
            emit({"event": "write", "link": str(message.get("link", "sim")), "frame": message.get("frame", "")})
        elif message.get("op") == "simulate-subscribe":
            emit({"event": "subscribe", "link": str(message.get("link", "sim")), "uuid": str(message.get("uuid", STATE_UUID)), "on": bool(message.get("on", True))})
        elif message.get("op") == "simulate-mtu":
            emit({"event": "mtu", "mtu": clamp_mtu(message.get("mtu"))})
    return 0


def run_bluez(args: argparse.Namespace) -> int:  # pragma: no cover - needs BlueZ and a radio
    try:
        import dbus
        import dbus.exceptions
        import dbus.mainloop.glib
        import dbus.service
        from gi.repository import GLib
    except ImportError as error:
        emit({"event": "error", "message": f"python3-dbus and python3-gi are needed: {error}"})
        return 2

    BLUEZ = "org.bluez"
    OBJ_MANAGER = "org.freedesktop.DBus.ObjectManager"
    PROPS = "org.freedesktop.DBus.Properties"
    GATT_MANAGER = "org.bluez.GattManager1"
    ADV_MANAGER = "org.bluez.LEAdvertisingManager1"
    SERVICE_IFACE = "org.bluez.GattService1"
    CHRC_IFACE = "org.bluez.GattCharacteristic1"
    ADV_IFACE = "org.bluez.LEAdvertisement1"
    APP_PATH = "/org/hydra/umc/ble"

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    loop = GLib.MainLoop()
    tracker = MtuTracker(lambda mtu: emit({"event": "mtu", "mtu": mtu}))
    state_first_frame = {"value": b""}

    def link_of(options: dict) -> str:
        device = options.get("device")
        return str(device) if device is not None else "link"

    def note_link(options: dict) -> str:
        link = link_of(options)
        if "mtu" in options:
            tracker.seen(link, int(options["mtu"]))
        return link

    class Application(dbus.service.Object):
        def __init__(self) -> None:
            self.services: list = []
            dbus.service.Object.__init__(self, bus, APP_PATH)

        @dbus.service.method(OBJ_MANAGER, out_signature="a{oa{sa{sv}}}")
        def GetManagedObjects(self):  # noqa: N802
            managed = {}
            for service in self.services:
                managed[service.get_path()] = service.get_properties()
                for chrc in service.chrcs:
                    managed[chrc.get_path()] = chrc.get_properties()
            return managed

    class Service(dbus.service.Object):
        def __init__(self, index: int) -> None:
            self.path = f"{APP_PATH}/service{index}"
            self.chrcs: list = []
            dbus.service.Object.__init__(self, bus, self.path)

        def get_path(self):
            return dbus.ObjectPath(self.path)

        def get_properties(self):
            return {SERVICE_IFACE: {"UUID": SERVICE_UUID, "Primary": dbus.Boolean(True)}}

        @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):  # noqa: N802
            return self.get_properties()[SERVICE_IFACE]

    class Characteristic(dbus.service.Object):
        def __init__(self, index: int, service: Service, uuid: str) -> None:
            self.path = f"{service.path}/char{index}"
            self.service = service
            self.uuid = uuid
            self.flags = characteristic_flags(uuid, args.require_encryption)
            dbus.service.Object.__init__(self, bus, self.path)

        def get_path(self):
            return dbus.ObjectPath(self.path)

        def get_properties(self):
            return {CHRC_IFACE: {"Service": self.service.get_path(), "UUID": self.uuid, "Flags": dbus.Array(self.flags, signature="s")}}

        @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):  # noqa: N802
            return self.get_properties()[CHRC_IFACE]

        @dbus.service.method(CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
        def ReadValue(self, options):  # noqa: N802
            note_link(options)
            if self.uuid == STATE_UUID:
                return dbus.Array([dbus.Byte(b) for b in state_first_frame["value"]], signature="y")
            return dbus.Array([], signature="y")

        @dbus.service.method(CHRC_IFACE, in_signature="aya{sv}")
        def WriteValue(self, value, options):  # noqa: N802
            link = note_link(options)
            if self.uuid != COMMAND_UUID:
                raise dbus.exceptions.DBusException("org.bluez.Error.NotSupported", "not writable")
            emit({"event": "write", "link": link, "frame": base64.b64encode(bytes(value)).decode("ascii")})

        @dbus.service.method(CHRC_IFACE)
        def StartNotify(self):  # noqa: N802
            emit({"event": "subscribe", "link": "notify", "uuid": self.uuid, "on": True})

        @dbus.service.method(CHRC_IFACE)
        def StopNotify(self):  # noqa: N802
            emit({"event": "subscribe", "link": "notify", "uuid": self.uuid, "on": False})

        @dbus.service.signal(PROPS, signature="sa{sv}as")
        def PropertiesChanged(self, interface, changed, invalidated):  # noqa: N802
            pass

        def notify(self, frame: bytes) -> None:
            value = dbus.Array([dbus.Byte(b) for b in frame], signature="y")
            self.PropertiesChanged(CHRC_IFACE, {"Value": value}, [])

    class Advertisement(dbus.service.Object):
        def __init__(self) -> None:
            self.path = f"{APP_PATH}/advertisement0"
            dbus.service.Object.__init__(self, bus, self.path)

        def get_path(self):
            return dbus.ObjectPath(self.path)

        @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):  # noqa: N802
            return {
                "Type": "peripheral",
                "ServiceUUIDs": dbus.Array([SERVICE_UUID], signature="s"),
                "LocalName": dbus.String(args.name),
                "Includes": dbus.Array(["tx-power"], signature="s"),
            }

        @dbus.service.method(ADV_IFACE)
        def Release(self):  # noqa: N802
            log("the advertisement was released by BlueZ")

    om = dbus.Interface(bus.get_object(BLUEZ, "/"), OBJ_MANAGER)
    adapter_path = args.adapter
    if not adapter_path:
        for path, interfaces in om.GetManagedObjects().items():
            if GATT_MANAGER in interfaces and ADV_MANAGER in interfaces:
                adapter_path = str(path)
                break
    if not adapter_path:
        emit({"event": "error", "message": "no Bluetooth adapter with GATT and advertising support"})
        return 3
    adapter = bus.get_object(BLUEZ, adapter_path)
    application = Application()
    service = Service(0)
    application.services.append(service)
    characteristics = {}
    for index, uuid in enumerate((STATE_UUID, COMMAND_UUID, ACK_UUID)):
        chrc = Characteristic(index, service, uuid)
        service.chrcs.append(chrc)
        characteristics[uuid] = chrc
    advertisement = Advertisement()

    def registered() -> None:
        emit({"event": "ready"})

    def failed(error) -> None:
        emit({"event": "error", "message": f"BlueZ refused: {error}"})
        loop.quit()

    dbus.Interface(adapter, GATT_MANAGER).RegisterApplication(dbus.ObjectPath(APP_PATH), {}, reply_handler=lambda: None, error_handler=failed)
    dbus.Interface(adapter, ADV_MANAGER).RegisterAdvertisement(advertisement.get_path(), {}, reply_handler=registered, error_handler=failed)

    def on_stdin(fd, condition) -> bool:
        if condition & GLib.IO_HUP:
            loop.quit()
            return False
        line = sys.stdin.readline()
        if not line:
            loop.quit()
            return False
        message = parse_line(line)
        if message is None:
            return True
        if message.get("op") == "stop":
            loop.quit()
            return False
        if message.get("op") == "notify":
            chrc = characteristics.get(str(message.get("uuid")))
            try:
                frame = base64.b64decode(str(message.get("frame", "")))
            except ValueError:
                return True
            if chrc is not None:
                if chrc.uuid == STATE_UUID and frame and (frame[0] & 0x01):
                    state_first_frame["value"] = frame
                chrc.notify(frame)
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    try:
        loop.run()
    finally:
        try:
            dbus.Interface(adapter, ADV_MANAGER).UnregisterAdvertisement(advertisement.get_path())
            dbus.Interface(adapter, GATT_MANAGER).UnregisterApplication(dbus.ObjectPath(APP_PATH))
        except Exception as error:  # noqa: BLE001
            log(f"unregistering failed: {error}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="BlueZ GATT helper of HYDRA-UMC-SERVER")
    parser.add_argument("--name", default="HYDRA-UMC", help="the name the device advertises")
    parser.add_argument("--adapter", default="", help="the D-Bus path of the adapter (the first one that can advertise when empty)")
    parser.add_argument("--require-encryption", action="store_true", help="the COMMAND characteristic is written only over an encrypted link")
    parser.add_argument("--simulate", action="store_true", help="no radio: only answer the lines of the server")
    args = parser.parse_args(argv)
    return run_simulated() if args.simulate else run_bluez(args)


if __name__ == "__main__":
    sys.exit(main())
