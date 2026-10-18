import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraAuthRequired, cameraAuthRequiredByDefault, issueMediaTicket, mediaTicketKey, MEDIA_TICKET_SECONDS, verifyMediaTicket } from "../src/mediaTickets.ts";

const key = mediaTicketKey("a-long-random-server-secret-for-the-tests-0123456789");
const now = 1_700_000_000_000;

test("a ticket opens the pictures for the person it was issued to, for five minutes", () => {
  const { ticket, expiresInSeconds } = issueMediaTicket(key, "operator-1", now);
  assert.equal(expiresInSeconds, MEDIA_TICKET_SECONDS);
  assert.equal(verifyMediaTicket(key, ticket, now), "operator-1");
  assert.equal(verifyMediaTicket(key, ticket, now + (MEDIA_TICKET_SECONDS - 1) * 1000), "operator-1");
  assert.equal(verifyMediaTicket(key, ticket, now + (MEDIA_TICKET_SECONDS + 1) * 1000), null);
});

test("a ticket that was changed, or signed with another key, is refused", () => {
  const { ticket } = issueMediaTicket(key, "operator-1", now);
  const [user, expiry, sig] = ticket.split(".");
  assert.equal(verifyMediaTicket(key, `${user}.${Number(expiry) + 600}.${sig}`, now), null);          // a longer life
  assert.equal(verifyMediaTicket(key, `${Buffer.from("admin").toString("base64url")}.${expiry}.${sig}`, now), null);   // another person
  assert.equal(verifyMediaTicket(mediaTicketKey("another-secret-of-the-same-length-0123456789012"), ticket, now), null);
  assert.equal(verifyMediaTicket(key, `${user}.${expiry}.${sig.slice(0, -2)}xx`, now), null);
});

test("what is not a ticket is refused without an error", () => {
  for (const value of [undefined, null, 42, "", "a.b", "a.b.c.d", "x".repeat(600), "bad.123.sig", { ticket: 1 }]) {
    assert.equal(verifyMediaTicket(key, value, now), null);
  }
});

test("the pictures only demand a ticket when the installation says so", () => {
  assert.equal(cameraAuthRequired(undefined), false);
  assert.equal(cameraAuthRequired("off"), false);
  assert.equal(cameraAuthRequired(" Required "), true);
});

test("the pictures demand a ticket by default and only an explicit opt-out opens them", () => {
  assert.equal(cameraAuthRequiredByDefault(undefined), true);
  assert.equal(cameraAuthRequiredByDefault(""), true);
  assert.equal(cameraAuthRequiredByDefault("required"), true);
  assert.equal(cameraAuthRequiredByDefault("anything-unknown"), true);
  for (const optOut of ["open", " OPEN ", "off", "false", "0", "no", "allow"]) assert.equal(cameraAuthRequiredByDefault(optOut), false, optOut);
});
