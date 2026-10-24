// A stand-in for scripts/ble_gatt_helper.py for the checks that run the whole server without a radio:
// it speaks the same JSON lines, but a "central" is a test that appends lines to data/ble-in.jsonl (the events
// the helper would print: write, subscribe, mtu) and reads data/ble-out.jsonl (what the server asked to notify).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const dir = path.join(process.cwd(), "data");
const input = path.join(dir, "ble-in.jsonl");
const output = path.join(dir, "ble-out.jsonl");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(input, "");
fs.writeFileSync(output, "");

let offset = 0;
let pending = "";
const poll = setInterval(() => {
  const size = fs.statSync(input).size;
  if (size <= offset) return;
  const fd = fs.openSync(input, "r");
  const buffer = Buffer.alloc(size - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  fs.closeSync(fd);
  offset = size;
  pending += buffer.toString("utf8");
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    process.stdout.write(pending.slice(0, newline) + "\n");
    pending = pending.slice(newline + 1);
  }
}, 20);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.op === "stop") {
    clearInterval(poll);
    process.exit(0);
  }
  if (message.op === "notify") fs.appendFileSync(output, line + "\n");
});
process.stdin.on("end", () => process.exit(0));

process.stdout.write(JSON.stringify({ event: "ready" }) + "\n");
