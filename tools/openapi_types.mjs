// Typed request and response schemas for the routes whose shapes are stable
// and read straight from their handlers. Routes not listed here keep the
// generic description. Used by generate_openapi.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const int = { type: "integer" };

// The shapes of the answers are not written here any more: the SDK owns them (contracts/sources/server.shapes.json), and this server carries a byte copy
// (tools/sdk/server.shapes.json) that tools/verify_sdk_contract.mjs compares with the SDK checkout whenever one is near. Change a shape in the SDK, copy the file,
// and `npm run openapi` regenerates docs/openapi.json from it.
export const SHAPES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "sdk", "server.shapes.json");

export function loadShapes(file = SHAPES_FILE) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  if (document.format !== "hydra-server-shapes/1" || !document.shapes || typeof document.shapes !== "object" || Array.isArray(document.shapes)) {
    throw new Error(`${file} is not a file of server shapes of the SDK (hydra-server-shapes/1)`);
  }
  return document.shapes;
}

export const SCHEMAS = loadShapes();

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// "METHOD /path" -> schema of the 200 response body.
export const RESPONSES = {
  "POST /api/login": ref("LoginResult"),
  "POST /api/refresh": ref("LoginResult"),
  "POST /api/logout": ref("Success"),
  "GET /api/totp/status": ref("TotpStatus"),
  "POST /api/totp/begin": ref("TotpEnrolment"),
  "POST /api/totp/confirm": ref("TotpConfirmed"),
  "POST /api/totp/disable": ref("Success"),
  "DELETE /api/users/{username}/totp": ref("Success"),
  "GET /api/system/metrics": ref("SystemMetrics"),
  "GET /api/users": ref("UserList"),
  "GET /api/connections/clients": ref("ConnectionClientList"),
  "GET /api/connections/events": ref("ConnectionEventList"),
  "POST /api/ecosystem/service/{unit}/{action}": ref("Success"),
  "POST /api/upload-work": ref("Success"),
  "GET /api/hydra-info": ref("HydraInfo"),
  "GET /api/settings": ref("Settings"),
  "GET /api/system/supervisor": ref("SupervisorSnapshot"),
  "GET /api/watch/system-status": ref("WatchStatus"),
  "POST /api/voice/turn": ref("VoiceReply"),
  "POST /api/voice/confirm": ref("Passthrough"),
  "GET /api/ecosystem/status": ref("EcosystemStatus"),
  "GET /api/telemetry/query": ref("Passthrough"),
  "GET /api/telemetry/aggregate": ref("Passthrough"),
  "GET /api/telemetry/downsample-plan": ref("Passthrough"),
  "PUT /api/telemetry/downsample-plan": ref("Passthrough"),
  "GET /api/adapters": ref("Passthrough"),
  "GET /api/adapters/{adapterId}": ref("Passthrough"),
  "POST /api/connector-hub/gate/evaluate": ref("Passthrough"),
  "GET /api/connector-hub/gate/audit": ref("Passthrough"),
  "GET /api/hardware/canota/version": ref("Passthrough"),
  "POST /api/stop-all": ref("StopAllResult"),
  "POST /api/stop-all/release": ref("GlobalStopReleased"),
  "POST /api/info/ticket": ref("InfoTicket"),
  "POST /api/admin/device-tokens": ref("DeviceTokenIssued"),
  "GET /api/admin/device-tokens": ref("DeviceTokenList"),
  "DELETE /api/admin/device-tokens/{id}": ref("DeviceTokenRevoked"),
  "POST /api/device/login": ref("LoginResult"),
  "GET /api/admin/updates": ref("UpdateReport"),
  "GET /api/admin/maintenance/status": ref("MaintenanceOutcome"),
  "GET /api/tool-arms": ref("ToolArmsReport"),
  "POST /api/tool-arms/reset": ref("ToolArmResetResult"),
  "POST /api/admin/maintenance/install": ref("MaintenanceOutcome"),
  "POST /api/admin/maintenance/rollback": ref("MaintenanceOutcome"),
  "POST /api/admin/maintenance/prune": ref("MaintenanceOutcome"),
  "POST /api/operator/presence": ref("OperatorPresenceAck"),
  "GET /api/operator/presence": ref("OperatorPresence"),
  "GET /health": ref("HealthReport"),
  "GET /.well-known/jwks.json": ref("JwksDocument"),
  "GET /api/admin/jwt-keys": ref("JwtKeys"),
  "POST /api/admin/jwt-keys/rotate": ref("JwtKeyRotated"),
  "GET /api/robots/liveness": ref("RobotLiveness"),
  "GET /api/ecosystem/health": ref("EcosystemHealth"),
  "GET /api/admin/service-identity": ref("ServiceIdentityStatus"),
  "POST /api/push/devices": ref("PushDeviceRegistered"),
  "DELETE /api/push/devices/{token}": ref("PushDeviceRemoved"),
  "GET /api/admin/push": ref("PushStatus"),
  "GET /api/rul/config": ref("RulConfig"),
  "GET /api/bridges": ref("BridgeList"),
  "GET /api/bridges/{name}/state": ref("BridgeState"),
  "POST /api/bridges/{name}/cmd/{verb}": ref("BridgeCommandAccepted"),
  "POST /api/robot/{id}/heartbeat": ref("Success"),
  "POST /api/robot/{id}/claim": ref("Reservation"),
  "POST /api/robot/{id}/release": ref("Reservation"),
  "POST /api/camera/{id}/snapshot": ref("CameraCapture"),
  "POST /api/camera/{id}/recording/start": ref("CameraCapture"),
  "POST /api/camera/{id}/recording/stop": ref("CameraCapture"),
  "GET /api/camera/media": ref("CameraMediaList"),
  "DELETE /api/camera/media/{cameraId}/{kind}/{filename}": ref("CameraCapture"),
  "GET /api/cameras/status": ref("CameraProcessStatus"),
  "GET /api/camera/discover-usb-devices": ref("UsbDevices"),
  "POST /api/camera/{id}/ptz": ref("PtzResult"),
  "GET /api/admin/clients": ref("Clients"),
  "GET /api/admin/logs": ref("LogLines"),
  "GET /api/admin/server-config": ref("ServerConfig"),
  "PUT /api/admin/server-config": ref("ServerConfigSaved"),
  "POST /api/admin/restart": ref("Success"),
  "POST /api/system/reboot": ref("Success"),
  "POST /api/system/shutdown": ref("Success"),
  "POST /api/settings": ref("Success"),
  "PUT /api/settings": ref("Success"),
  "PUT /api/users/{username}": ref("Success"),
  "DELETE /api/users/{username}": ref("Success"),
  "POST /api/users": ref("Success"),
  "POST /api/integrations/test-connection": ref("Reachable"),
  "GET /api/models": ref("ModelList"),
  "POST /api/models/submit": ref("ModelSubmitted"),
  "POST /api/system/bluetooth/scan": ref("BluetoothScan"),
  "POST /api/system/bluetooth/power": ref("Success"),
  "POST /api/system/bluetooth/remove": ref("Success"),
  "POST /api/hardware/canota/flash": ref("CanotaFlash"),
  // Local to this server (the SDK has no shape for it): the robot ids that more than one robot uses.
  "GET /api/admin/robot-ids": {
    type: "object",
    required: ["ok", "ambiguousCount", "ambiguous"],
    properties: {
      ok: { type: "boolean", description: "False while at least one robot id is used by more than one robot." },
      ambiguousCount: { type: "integer" },
      ambiguous: {
        type: "array",
        description: "The routes by these ids answer 409 robot_id_ambiguous. Controller ids only.",
        items: { type: "object", required: ["robotId", "controllers"], properties: { robotId: { type: "integer" }, controllers: { type: "array", items: { type: "string" } } } },
      },
    },
  },
};

// "METHOD /path" -> { required: [...], fields: { name: schema } } for the request body.
export const REQUESTS = {
  "POST /api/login": { required: ["username", "password"], fields: { username: str, password: str, totp: str } },
  "POST /api/totp/begin": { required: ["password"], fields: { password: str } },
  "POST /api/totp/confirm": { required: ["code"], fields: { code: str } },
  "POST /api/totp/disable": { required: ["password", "code"], fields: { password: str, code: str } },
  "POST /api/refresh": { required: ["refreshToken"], fields: { refreshToken: str } },
  "POST /api/device/login": { required: ["token"], fields: { token: str } },
  "POST /api/tool-arms/reset": { required: ["robot", "toolId", "confirm"], fields: { robot: str, toolId: num, confirm: str } },
  "POST /api/admin/maintenance/install": { required: ["package", "confirm"], fields: { package: str, allowDowngrade: bool, confirm: bool } },
  "POST /api/admin/maintenance/rollback": { required: ["component", "confirm"], fields: { component: str, confirm: bool } },
  "POST /api/admin/maintenance/prune": { required: ["component", "confirm"], fields: { component: str, keep: num, confirm: bool } },
  "POST /api/admin/device-tokens": { required: ["name", "username", "confirm"], fields: { name: str, username: str, ttlDays: num, confirm: bool } },
  "POST /api/logout": { required: [], fields: { refreshToken: str } },
  "POST /api/users": { required: ["username", "password", "role"], fields: { username: str, password: str, role: str } },
  "POST /api/upload-work": { required: ["folderPath", "fileName", "content"], fields: { folderPath: str, fileName: str, content: str } },
  "POST /api/models/submit": {
    required: ["name", "category", "urdfXml"],
    fields: {
      name: str, category: str, urdfFilename: str, urdfXml: str, overwrite: bool,
      meshFiles: { type: "array", items: { type: "object", required: ["filename", "base64"], properties: { filename: str, base64: str } } },
      attribution: { type: "string", maxLength: 8000, description: "Licence and credit of the model and its meshes; required when the operator turned requireAttribution on." },
    },
  },
  "POST /api/system/bluetooth/power": { required: ["on"], fields: { on: bool } },
  "POST /api/system/bluetooth/pair": { required: ["mac"], fields: { mac: str } },
  "POST /api/system/bluetooth/remove": { required: ["mac"], fields: { mac: str } },
  "PUT /api/admin/server-config": { required: ["port"], fields: { port: int } },
  "PUT /api/users/{username}": { required: [], fields: { newUsername: str, password: str, role: str } },
  "POST /api/robot/{id}/claim": { required: [], fields: { ttlMs: num, force: bool, reason: str } },
  "POST /api/robot/{id}/release": { required: [], fields: { reason: str } },
  "POST /api/integrations/test-connection": { required: ["host", "port"], fields: { host: str, port: int } },
  "POST /api/camera/discover-rtsp-path": { required: ["host"], fields: { host: str, port: int, username: str, password: str } },
  "POST /api/camera/{id}/ptz": { required: ["host"], fields: { host: str, port: int, username: str, password: str, channel: int, pan: num, tilt: num, zoom: num } },
  "POST /api/push/devices": { required: ["token", "platform"], fields: { token: str, platform: { type: "string", enum: ["ios"] }, locale: { type: "string", enum: ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] } } },
  "POST /api/robot/{id}/command": { required: ["command"], fields: { command: str, params: { type: "object" }, seq: int } },
  "POST /api/bridges/{name}/cmd/{verb}": { required: [], fields: {} },
  "POST /api/operator/presence": { required: ["sequence", "intervalSeconds", "state"], fields: { type: { type: "string", enum: ["presence_heartbeat"] }, protocolVersion: int, sequence: int, intervalSeconds: num, state: { type: "string", enum: ["PRESENT", "LEFT"] } } },
};

// "METHOD /path" -> status codes that a shared middleware answers before the handler runs, so the handler's own source does not show them.
export const EXTRA_STATUSES = {
  // The whole tree is saved only when If-Match carries the ETag of the last GET: 428 without it, 412 when it is stale.
  // (the save itself is shared by POST and PUT, so its 200, 409 and 500 do not show in either handler)
  "PUT /api/settings": [200, 409, 412, 428, 500],
  "POST /api/settings": [200, 409, 500],
  // The public key set: 404 while the server signs HS256 (the default), 503 when the key file cannot be read.
  "GET /.well-known/jwks.json": [200, 404, 503],
  "GET /api/admin/jwt-keys": [200, 500],
  // 409 while the algorithm is HS256: there is nothing asymmetric to rotate.
  "POST /api/admin/jwt-keys/rotate": [200, 409, 500],
  // 404 while ecosystemHealth.enabled is off (as if the route did not exist), 403 for a viewer.
  "GET /api/ecosystem/health": [403, 404],
  // 404 while deviceTokens.enabled is off (as if the routes did not exist); 409 when there are already as many active tokens as allowed.
  "POST /api/admin/device-tokens": [409],
  "GET /api/admin/device-tokens": [404],
  // 404 while updateCheck.enabled is off.
  "GET /api/admin/updates": [404],
  // 404 while maintenance.enabled is off (as if the routes did not exist); 400 for a request the checks refuse or that lacks confirm; 409 while another run is going on; 502 when the deploy tool ran and failed.
  "GET /api/admin/maintenance/status": [400, 404, 502],
  // 503 until the safety zones service has an address (or when it is down), 404 when it runs without --tool-arms, 502 when it answers something that is not JSON.
  "GET /api/tool-arms": [404, 502, 503],
  // 404 while atc.resetEnabled is off (as if the route did not exist); 400 for a request the checks refuse or whose confirm does not repeat the robot id; 409 unless the robot is stopped and every tool of it is reported disarmed and fresh; 502 when the tool changer service rejects it; 503 until the safety zones and tool changer services have an address (or when one is down).
  "POST /api/tool-arms/reset": [400, 404, 409, 502, 503],
  "POST /api/admin/maintenance/install": [400, 404, 409, 502],
  "POST /api/admin/maintenance/rollback": [400, 404, 409, 502],
  "POST /api/admin/maintenance/prune": [400, 404, 409, 502],
  // 404 while push.enabled is off (as if the route did not exist).
  "POST /api/push/devices": [404],
  "DELETE /api/push/devices/{token}": [404],
  // 404 while presence.enabled is off (as if the routes did not exist), 403 for a viewer.
  "POST /api/operator/presence": [403, 404],
  "GET /api/operator/presence": [403, 404],
  // 404 while bridgeGateway.enabled is off (as if the routes did not exist), 403 for a viewer on the command.
  "GET /api/bridges": [404],
  "GET /api/bridges/{name}/state": [404, 503],
  "POST /api/bridges/{name}/cmd/{verb}": [200, 403, 404, 409, 413, 429, 502, 503],
};

// "METHOD /path" -> status codes whose answer has no body at all (a switch that is off answers a bare 404).
export const EMPTY_BODY_STATUSES = {
  "GET /api/ecosystem/health": [404],
  "POST /api/push/devices": [404],
  "DELETE /api/push/devices/{token}": [404],
  "POST /api/operator/presence": [404],
  "GET /api/operator/presence": [404],
  "GET /api/bridges": [404],
  "GET /api/bridges/{name}/state": [],
  "POST /api/bridges/{name}/cmd/{verb}": [],
};

export const errorResponse = ref("Error");
export const jsonContent = (schema) => ({ "application/json": { schema } });
