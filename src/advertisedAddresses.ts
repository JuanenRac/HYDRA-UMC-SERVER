// =============================================================================
// HYDRA-UMC-SERVER - src/advertisedAddresses.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The addresses a client on the local network can reach this server at, for the answer of GET /api/hydra-info (only while the switch
// discovery.advertiseAddress is on). A client that found the server by scanning already knows one address; the list lets a person copy the
// address another device must use (a phone or a screen to pair) without reading it from a network settings page.
import os from "node:os";

export interface AdvertisedAddressInput {
  port: number;
  tls: boolean;
  /** The interfaces of the host (tests pass fixed ones). */
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** The most addresses to list (8 by default). */
  limit?: number;
}

/** `http(s)://<IPv4>:<port>` of every external, non-link-local IPv4 interface, sorted, without duplicates. IPv6 and loopback are left out on purpose. */
export function advertisedAddresses(input: AdvertisedAddressInput): string[] {
  const scheme = input.tls ? "https" : "http";
  const found = new Set<string>();
  for (const list of Object.values(input.interfaces ?? os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.internal || (item.family as string | number) !== "IPv4" && (item.family as string | number) !== 4) continue;
      if (item.address.startsWith("169.254.")) continue;
      found.add(`${scheme}://${item.address}:${input.port}`);
    }
  }
  return [...found].sort().slice(0, Math.max(1, input.limit ?? 8));
}
