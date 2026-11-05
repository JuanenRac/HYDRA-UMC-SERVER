// =============================================================================
// HYDRA-UMC-SERVER - src/anomalyFeedBroker.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Reads the retained `anomaly-verdict/1` messages from the broker the server already uses and hands them to the feed; when a verdict
// changes to one worth saying and the relay switch is on, tells the voice interface (HYDRA-UMC-VOICE-UI, `POST /v1/voice/alert`). Read
// only towards the broker: this connection never publishes. It starts only when HYDRA_UMC_ANOMALY_FEED is "1" and the broker URL is set.
import { connect as mqttConnect } from "mqtt";
import { type AnomalyFeed, type AnomalyVerdict, parseAnomalyVerdict, voiceAlertBody } from "./anomalyFeed";
import type { BrokerOptions } from "./ingestFeeds";

export interface AnomalyFeedClient { stop(): Promise<void> }

/** What the relay needs to reach the voice interface; `null` leaves the relay off. */
export interface VoiceRelay {
  send(body: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  locale: string;
}

export async function relayToVoice(feed: AnomalyFeed, verdict: AnomalyVerdict, relay: VoiceRelay, log: (message: string) => void): Promise<void> {
  const body = voiceAlertBody(verdict, relay.locale);
  if (!body) return;
  try {
    const reply = await relay.send(body);
    if (reply) feed.setAlert(verdict, reply);
  } catch (error) {
    log(`[anomaly] the voice interface could not be told: ${error instanceof Error ? error.message : error}`);
  }
}

export function startAnomalyFeed(
  feed: AnomalyFeed,
  options: BrokerOptions & { log: (message: string) => void; relay?: VoiceRelay | null; connect?: typeof mqttConnect },
): AnomalyFeedClient {
  const client = (options.connect ?? mqttConnect)(options.url, { username: options.username, password: options.password, reconnectPeriod: 5000, clientId: `hydra-umc-server-anomaly-${process.pid}` });
  client.on("connect", () => {
    client.subscribe(options.topic, { qos: 1 }, (error) => {
      options.log(error ? `[anomaly] could not subscribe to ${options.topic}: ${error.message}` : `[anomaly] reading ${options.topic}`);
    });
  });
  client.on("message", (_topic, payload) => {
    const verdict = parseAnomalyVerdict(payload);
    if (!verdict) return; // not an anomaly-verdict/1: ignored, never stored
    try {
      const { changed } = feed.record(verdict);
      if (changed && options.relay) void relayToVoice(feed, verdict, options.relay, options.log);
    } catch (error) {
      options.log(`[anomaly] a verdict was not recorded: ${error instanceof Error ? error.message : error}`);
    }
  });
  client.on("error", (error) => options.log(`[anomaly] broker: ${error.message}`));
  return { stop: () => new Promise((resolve) => client.end(false, {}, () => resolve())) };
}
