// Typed request and response schemas for the routes whose shapes are stable
// and read straight from their handlers. Routes not listed here keep the
// generic description. Used by generate_openapi.mjs.

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const nullableNum = { type: ["number", "null"] };

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
  "POST /api/robot/{id}/command": { required: ["command"], fields: { command: str, params: { type: "object" } } },
};

export const errorResponse = ref("Error");
export const jsonContent = (schema) => ({ "application/json": { schema } });
