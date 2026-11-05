// =============================================================================
// HYDRA-UMC-SERVER - src/faultFeedBroker.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Reads `fault-event/1` messages from the broker the server already uses for telemetry and hands them to the feed. Read only: this
// connection never publishes. It starts only when the switch HYDRA_UMC_FAULT_FEED is "1" and the broker URL is set.
import { connect as mqttConnect } from "mqtt";
import { parseFaultEvent, type FaultFeed, type BrokerOptions } from "./ingestFeeds";

export interface FaultFeedClient { stop(): Promise<void> }

export function startFaultFeed(feed: FaultFeed, options: BrokerOptions & { log: (message: string) => void; connect?: typeof mqttConnect }): FaultFeedClient {
  const client = (options.connect ?? mqttConnect)(options.url, { username: options.username, password: options.password, reconnectPeriod: 5000, clientId: `hydra-umc-server-faults-${process.pid}` });
  client.on("connect", () => {
    client.subscribe(options.topic, { qos: 1 }, (error) => {
      options.log(error ? `[faults] could not subscribe to ${options.topic}: ${error.message}` : `[faults] reading ${options.topic}`);
    });
  });
  client.on("message", (_topic, payload) => {
    const event = parseFaultEvent(payload);
    if (!event) return; // not a fault-event/1: ignored, never stored
    try { feed.record(event); } catch (error) { options.log(`[faults] a fault was not recorded: ${error instanceof Error ? error.message : error}`); }
  });
  client.on("error", (error) => options.log(`[faults] broker: ${error.message}`));
  return { stop: () => new Promise((resolve) => client.end(false, {}, () => resolve())) };
}
