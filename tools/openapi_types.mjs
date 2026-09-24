// Typed request and response schemas for the routes whose shapes are stable
// and read straight from their handlers. Routes not listed here keep the
// generic description. Used by generate_openapi.mjs.

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const nullableNum = { type: ["number", "null"] };
const int = { type: "integer" };
const obj = { type: "object" };
const list = { type: "array", items: { type: "object" } };
const strings = { type: "array", items: { type: "string" } };

export const SCHEMAS = {
  Error: {
    type: "object",
    required: ["error"],
    properties: { error: str },
  },
  Success: {
    type: "object",
    required: ["success"],
    properties: { success: bool },
  },
  LoginResult: {
    type: "object",
    required: ["success", "token", "refreshToken", "role"],
    properties: { success: bool, token: str, refreshToken: str, role: str },
  },
  SystemMetrics: {
    type: "object",
    required: ["cpu_load", "memory_usage", "temp", "temp_is_real", "rp1_temp", "uptime", "network"],
    properties: {
      cpu_load: num,
      memory_usage: num,
      temp: nullableNum,
      temp_is_real: bool,
      rp1_temp: nullableNum,
      uptime: num,
      network: { type: "object" },
    },
  },
  HydraInfo: {
    type: "object",
    required: ["schema_version", "product", "remoteApiVersion", "appVersion", "hostname", "controllerCount", "robotCount", "uptimeSeconds"],
    properties: { schema_version: str, product: str, remoteApiVersion: int, appVersion: str, hostname: str, controllerCount: int, robotCount: int, uptimeSeconds: int },
  },
  Reservation: {
    type: "object",
    required: ["success", "reservationHistory"],
    properties: { success: bool, reservation: { type: ["object", "null"] }, reservationHistory: list },
  },
  CameraCapture: {
    type: "object",
    required: ["success", "cameraId", "filename"],
    properties: { success: bool, cameraId: int, filename: str, capturedAt: str, sizeBytes: int, startedAt: str, stoppedAt: str },
  },
  CameraMediaList: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["cameraId", "kind", "filename", "sizeBytes", "capturedAt", "recording"],
          properties: {
            cameraId: int,
            kind: { type: "string", enum: ["snapshots", "recordings"] },
            filename: str,
            sizeBytes: int,
            capturedAt: str,
            recording: bool,
            durationMs: int,
            frameCount: int,
          },
        },
      },
    },
  },
  CameraProcessStatus: {
    type: "object",
    additionalProperties: {
      type: "object",
      required: ["status", "lastError", "port"],
      properties: { status: str, lastError: { type: ["string", "null"] }, port: int },
    },
  },
  UsbDevices: { type: "object", required: ["devices"], properties: { devices: list } },
  Clients: { type: "object", required: ["clients"], properties: { clients: list } },
  LogLines: { type: "object", required: ["lines"], properties: { lines: strings } },
  ServerConfig: {
    type: "object",
    required: ["port", "pendingPort"],
    properties: { port: int, pendingPort: { type: ["integer", "null"] } },
  },
  ServerConfigSaved: {
    type: "object",
    required: ["success", "appliesOnRestart"],
    properties: { success: bool, appliesOnRestart: bool },
  },
  Reachable: { type: "object", required: ["reachable"], properties: { reachable: bool } },
  ModelList: { type: "object", required: ["models"], properties: { models: list } },
  ModelSubmitted: { type: "object", required: ["success", "slug"], properties: { success: bool, slug: str } },
  BluetoothScan: { type: "object", required: ["success", "devices"], properties: { success: bool, devices: list } },
  CanotaFlash: { type: "object", required: ["success", "finalPhase"], properties: { success: bool, finalPhase: str } },
  PtzResult: { type: "object", required: ["ok"], properties: { ok: bool } },
  Passthrough: {
    type: "object",
    description: "The body of the upstream service, relayed unchanged; its shape is that service's own.",
  },
  Settings: {
    type: "object",
    description: "The full settings document. Controllers and their robots are listed under controllers[].robots.",
    properties: { controllers: list },
  },
  SupervisorSnapshot: {
    type: "object",
    description: "Host deep-dive: CPU per core, memory, disks, network, temperatures. Fields the host cannot report are null.",
  },
  WatchStatus: {
    type: "object",
    required: ["type", "headline", "detail", "level", "speak"],
    properties: { type: { const: "system_status" }, headline: str, detail: str, level: { type: "string", enum: ["NOMINAL", "WARNING", "CRITICAL"] }, speak: bool },
  },
  VoiceReply: {
    type: "object",
    required: ["type", "requestId", "text", "level", "speak", "requiresConfirmation"],
    properties: {
      type: { const: "assistant_reply" },
      requestId: str,
      text: str,
      level: str,
      speak: bool,
      requiresConfirmation: bool,
      visualState: str,
      intent: obj,
      interpretation: obj,
      confirmationToken: str,
      confirmationValiditySeconds: num,
    },
  },
  EcosystemStatus: {
    type: "object",
    required: ["available", "scannedAt", "projects"],
    properties: {
      available: bool,
      scannedAt: str,
      projects: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: str,
            role: { type: ["string", "null"] },
            stack: { type: ["string", "null"] },
            maturity: { type: ["string", "null"] },
            family: { type: ["string", "null"] },
            version: { type: ["string", "null"] },
            deploymentTarget: { type: ["string", "null"] },
            servicePort: { type: ["integer", "null"] },
            serviceHealthPath: { type: ["string", "null"] },
            serviceHost: { type: ["string", "null"] },
            systemdUnit: { type: ["string", "null"] },
            pid: { type: ["integer", "null"] },
            activeState: { type: ["string", "null"] },
            subState: { type: ["string", "null"] },
            live: { type: ["boolean", "null"] },
          },
        },
      },
    },
  },
  UserList: {
    type: "object",
    required: ["users"],
    properties: { users: { type: "array", items: { type: "object" } } },
  },
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// "METHOD /path" -> schema of the 200 response body.
export const RESPONSES = {
  "POST /api/login": ref("LoginResult"),
  "POST /api/refresh": ref("LoginResult"),
  "POST /api/logout": ref("Success"),
  "GET /api/system/metrics": ref("SystemMetrics"),
  "GET /api/users": ref("UserList"),
  "POST /api/ecosystem/service/{unit}/{action}": ref("Success"),
  "POST /api/upload-work": ref("Success"),
  "GET /api/hydra-info": ref("HydraInfo"),
  "GET /api/settings": ref("Settings"),
  "GET /api/system/supervisor": ref("SupervisorSnapshot"),
  "GET /api/watch/system-status": ref("WatchStatus"),
  "POST /api/voice/turn": ref("VoiceReply"),
  "GET /api/ecosystem/status": ref("EcosystemStatus"),
  "GET /api/telemetry/query": ref("Passthrough"),
  "GET /api/telemetry/aggregate": ref("Passthrough"),
  "GET /api/adapters": ref("Passthrough"),
  "GET /api/adapters/{adapterId}": ref("Passthrough"),
  "GET /api/hardware/canota/version": ref("Passthrough"),
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
  "POST /api/settings": ref("Success"),
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
};

// "METHOD /path" -> { required: [...], fields: { name: schema } } for the request body.
export const REQUESTS = {
  "POST /api/login": { required: ["username", "password"], fields: { username: str, password: str } },
  "POST /api/refresh": { required: ["refreshToken"], fields: { refreshToken: str } },
  "POST /api/logout": { required: [], fields: { refreshToken: str } },
  "POST /api/users": { required: ["username", "password", "role"], fields: { username: str, password: str, role: str } },
  "POST /api/upload-work": { required: ["folderPath", "fileName", "content"], fields: { folderPath: str, fileName: str, content: str } },
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
  "POST /api/robot/{id}/command": { required: ["command"], fields: { command: str, params: { type: "object" } } },
};

export const errorResponse = ref("Error");
export const jsonContent = (schema) => ({ "application/json": { schema } });
