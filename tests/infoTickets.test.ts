import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INFO_TICKET_DEFAULT_SECONDS, INFO_TICKET_LIMIT_SECONDS, INFO_TICKET_MIN_SECONDS, infoTicketKey, infoTicketSeconds, issueInfoTicket, verifyInfoTicket,
} from "../src/infoTickets.ts";
import { issueMediaTicket, mediaTicketKey, verifyMediaTicket } from "../src/mediaTickets.ts";
import { SecurityConfig, SecurityConfigError, resolveInfoTickets, type SecurityFile } from "../src/securityConfig.ts";

const secret = "a-long-random-server-secret-for-the-tests-0123456789";
const key = infoTicketKey(secret);
const now = 1_700_000_000_000;

test("a ticket opens the information routes for the person it was issued to until it expires", () => {
  const { ticket, expiresInSeconds } = issueInfoTicket(key, "dashboard", now, 600);
  assert.equal(expiresInSeconds, 600);
  assert.equal(verifyInfoTicket(key, ticket, now), "dashboard");
  assert.equal(verifyInfoTicket(key, ticket, now + 599_000), "dashboard");
  assert.equal(verifyInfoTicket(key, ticket, now + 601_000), null);
});

test("a ticket that was changed, or signed with another key, is refused", () => {
  const { ticket } = issueInfoTicket(key, "dashboard", now, 300);
  const [user, expiry, sig] = ticket.split(".");
  assert.equal(verifyInfoTicket(key, `${user}.${Number(expiry) + 600}.${sig}`, now), null);
  assert.equal(verifyInfoTicket(key, `${Buffer.from("admin").toString("base64url")}.${expiry}.${sig}`, now), null);
  assert.equal(verifyInfoTicket(infoTicketKey("another-secret-of-the-same-length-0123456789012"), ticket, now), null);
  assert.equal(verifyInfoTicket(key, `${user}.${expiry}.${sig.slice(0, -2)}xx`, now), null);
});

test("a ticket of the camera pictures is not a ticket of the information routes, nor the other way round", () => {
  const camera = issueMediaTicket(mediaTicketKey(secret), "dashboard", now).ticket;
  const info = issueInfoTicket(key, "dashboard", now, 300).ticket;
  assert.equal(verifyInfoTicket(key, camera, now), null);
  assert.equal(verifyMediaTicket(mediaTicketKey(secret), info, now), null);
  assert.notDeepEqual(key, mediaTicketKey(secret));
});

test("what is not a ticket is refused without an error", () => {
  for (const value of [undefined, null, 42, "", "a.b", "a.b.c.d", "x".repeat(600), "bad.123.sig", { ticket: 1 }, ["a", "b", "c"]]) {
    assert.equal(verifyInfoTicket(key, value, now), null);
  }
});

test("the life of a ticket is the default unless the file and the request say another, never beyond the maximum", () => {
  assert.equal(infoTicketSeconds(undefined, undefined), INFO_TICKET_DEFAULT_SECONDS);
  assert.equal(infoTicketSeconds({}, "abc"), INFO_TICKET_DEFAULT_SECONDS);
  assert.equal(infoTicketSeconds({ maxTtlSeconds: 3600 }, 1200), 1200);
  assert.equal(infoTicketSeconds({ maxTtlSeconds: 3600 }, 1e9), 3600);
  assert.equal(infoTicketSeconds({ maxTtlSeconds: 3600 }, 1), INFO_TICKET_MIN_SECONDS);
  assert.equal(infoTicketSeconds({ maxTtlSeconds: 3600, ttlSeconds: 900 }, undefined), 900);
  assert.equal(infoTicketSeconds({ maxTtlSeconds: 600, ttlSeconds: 900 }, undefined), 600, "the default life never beats the maximum");
  assert.equal(infoTicketSeconds({ maxTtlSeconds: 1e12 }, 1e12), INFO_TICKET_LIMIT_SECONDS);
  assert.equal(infoTicketSeconds({ maxTtlSeconds: "no" }, 100000), INFO_TICKET_DEFAULT_SECONDS, "a value that is not a number gives the default");
});

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("the tickets are off by default, only the exact word 1 turns them on from the environment", () => {
  const { config } = makeConfig({});
  assert.equal(config.infoTicketsEnabled(), false);
  assert.deepEqual(config.snapshot().infoTickets.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ infoTickets: "1" }).config.infoTicketsEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ infoTickets: word }).config.infoTicketsEnabled(), false, word);
  assert.deepEqual(resolveInfoTickets(undefined, { infoTickets: { enabled: true } }), { value: true, source: "config" });
  assert.equal(resolveInfoTickets("0", { infoTickets: { enabled: true } }).value, false);
});

test("an administrator turns the tickets on and off, keeping the limits of the file, and the environment locks the switch", () => {
  const { config, logs, stored } = makeConfig({}, { infoTickets: { maxTtlSeconds: 3600 } });
  const on = config.update({ infoTickets: { enabled: true } }, "root");
  assert.ok(on.warnings.includes("info_tickets_on"));
  assert.equal(config.infoTicketsEnabled(), true);
  assert.deepEqual(stored().infoTickets, { enabled: true, maxTtlSeconds: 3600 });
  assert.ok(logs.some((line) => line.includes("signed tickets of the information routes")));
  config.update({ infoTickets: { enabled: false } }, "root");
  assert.equal(config.infoTicketsEnabled(), false);
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) assert.throws(() => config.update({ infoTickets: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ infoTickets: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ infoTickets: "1" }).config.update({ infoTickets: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409);
});
