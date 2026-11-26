// =============================================================================
// HYDRA-UMC-SERVER - src/voiceText.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The spoken status the server writes into a voice reply, in the eight languages of the ecosystem. The language is the one of the
// `locale` the client sent with the turn (the watch sends its own); a locale that is none of the eight gets English.

export const VOICE_LANGUAGES = ["en", "es", "de", "fr", "it", "ja", "zh", "pt"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export function voiceLanguageOf(locale: unknown): VoiceLanguage {
  if (typeof locale === "string") {
    const primary = locale.replace(/_/g, "-").split("-")[0].trim().toLowerCase();
    if ((VOICE_LANGUAGES as readonly string[]).includes(primary)) return primary as VoiceLanguage;
  }
  return "en";
}

interface StatusSentences {
  controllers: (n: number) => string;
  robots: (n: number) => string;
  summary: (controllers: string, robots: string, cpu: number, memory: number, uptime: number) => string;
  registered: (robotId: number) => string;
  notRegistered: (robotId: number) => string;
  /** What this server last heard of a registered robot: news within the stale limit, older news, or none since it started. */
  news: (news: RobotNews) => string;
}

/** What the server knows of the last news of one robot (a command carried out, a change of its state, a heartbeat): never a claim about the machine itself. */
export interface RobotNews {
  state: "live" | "stale" | "unknown";
  /** Seconds since the last news (absent while the state is unknown). */
  ageS?: number;
}

const english = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const SENTENCES: Record<VoiceLanguage, StatusSentences> = {
  en: {
    controllers: (n) => english(n, "controller", "controllers"),
    robots: (n) => english(n, "robot", "robots"),
    summary: (c, r, cpu, mem, up) => `${c}, ${r} configured. CPU load ${cpu}%, memory ${mem}%, uptime ${up}s.`,
    registered: (id) => `Robot ${id} is registered on this Server. `,
    notRegistered: (id) => `Robot ${id} is not registered on this Server. `,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `Its last news arrived ${a}s ago. ` : n.state === "stale" ? `It has been silent for ${a}s. ` : `It has sent no news since this Server started. `;
    },
  },
  es: {
    controllers: (n) => english(n, "controlador", "controladores"),
    robots: (n) => english(n, "robot", "robots"),
    summary: (c, r, cpu, mem, up) => `${c} y ${r} configurados. Carga de CPU ${cpu}%, memoria ${mem}%, tiempo activo ${up}s.`,
    registered: (id) => `El robot ${id} está registrado en este servidor. `,
    notRegistered: (id) => `El robot ${id} no está registrado en este servidor. `,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `Su última noticia llegó hace ${a} s. ` : n.state === "stale" ? `Lleva ${a} s en silencio. ` : `No ha enviado noticias desde que arrancó este servidor. `;
    },
  },
  de: {
    controllers: (n) => english(n, "Controller", "Controller"),
    robots: (n) => english(n, "Roboter", "Roboter"),
    summary: (c, r, cpu, mem, up) => `${c} und ${r} konfiguriert. CPU-Last ${cpu}%, Speicher ${mem}%, Laufzeit ${up}s.`,
    registered: (id) => `Roboter ${id} ist auf diesem Server registriert. `,
    notRegistered: (id) => `Roboter ${id} ist auf diesem Server nicht registriert. `,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `Die letzte Meldung kam vor ${a} s. ` : n.state === "stale" ? `Er schweigt seit ${a} s. ` : `Seit dem Start dieses Servers hat er nichts gemeldet. `;
    },
  },
  fr: {
    controllers: (n) => english(n, "contrôleur", "contrôleurs"),
    robots: (n) => english(n, "robot", "robots"),
    summary: (c, r, cpu, mem, up) => `${c} et ${r} configurés. Charge CPU ${cpu} %, mémoire ${mem} %, durée de fonctionnement ${up} s.`,
    registered: (id) => `Le robot ${id} est enregistré sur ce serveur. `,
    notRegistered: (id) => `Le robot ${id} n'est pas enregistré sur ce serveur. `,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `Sa dernière nouvelle date d'il y a ${a} s. ` : n.state === "stale" ? `Il est silencieux depuis ${a} s. ` : `Il n'a rien envoyé depuis le démarrage de ce serveur. `;
    },
  },
  it: {
    controllers: (n) => english(n, "controller", "controller"),
    robots: (n) => english(n, "robot", "robot"),
    summary: (c, r, cpu, mem, up) => `${c} e ${r} configurati. Carico CPU ${cpu}%, memoria ${mem}%, tempo di attività ${up}s.`,
    registered: (id) => `Il robot ${id} è registrato su questo server. `,
    notRegistered: (id) => `Il robot ${id} non è registrato su questo server. `,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `L'ultima notizia è arrivata ${a} s fa. ` : n.state === "stale" ? `È in silenzio da ${a} s. ` : `Non ha inviato notizie da quando questo server è avviato. `;
    },
  },
  ja: {
    controllers: (n) => `コントローラ${n}台`,
    robots: (n) => `ロボット${n}台`,
    summary: (c, r, cpu, mem, up) => `${c}、${r}が設定されています。CPU負荷${cpu}%、メモリ${mem}%、稼働時間${up}秒。`,
    registered: (id) => `ロボット${id}はこのサーバーに登録されています。`,
    notRegistered: (id) => `ロボット${id}はこのサーバーに登録されていません。`,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `最後の連絡は${a}秒前です。` : n.state === "stale" ? `${a}秒間、連絡がありません。` : `このサーバーの起動以降、連絡はありません。`;
    },
  },
  zh: {
    controllers: (n) => `${n} 个控制器`,
    robots: (n) => `${n} 个机器人`,
    summary: (c, r, cpu, mem, up) => `已配置 ${c}、${r}。CPU 负载 ${cpu}%，内存 ${mem}%，运行时间 ${up} 秒。`,
    registered: (id) => `机器人 ${id} 已在此服务器上注册。`,
    notRegistered: (id) => `机器人 ${id} 未在此服务器上注册。`,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `最近一次消息是 ${a} 秒前。` : n.state === "stale" ? `已沉默 ${a} 秒。` : `自此服务器启动以来没有收到任何消息。`;
    },
  },
  pt: {
    controllers: (n) => english(n, "controlador", "controladores"),
    robots: (n) => english(n, "robô", "robôs"),
    summary: (c, r, cpu, mem, up) => `${c} e ${r} configurados. Carga do CPU ${cpu}%, memória ${mem}%, tempo de atividade ${up}s.`,
    registered: (id) => `O robô ${id} está registado neste servidor. `,
    notRegistered: (id) => `O robô ${id} não está registado neste servidor. `,
    news: (n) => {
      const a = n.ageS ?? 0;
      return n.state === "live" ? `A última notícia chegou há ${a} s. ` : n.state === "stale" ? `Está em silêncio há ${a} s. ` : `Não enviou notícias desde que este servidor arrancou. `;
    },
  },
};

export interface VoiceStatusFacts {
  controllerCount: number;
  robotCount: number;
  cpuLoad: number;
  memoryUsage: number;
  uptime: number;
  // present when the person asked for one robot: whether this server has it registered
  robotId?: number;
  robotRegistered?: boolean;
  // present for a registered robot when the server can say when it last had news of it
  robotNews?: RobotNews;
}

export function voiceStatusText(facts: VoiceStatusFacts, locale: unknown): string {
  const s = SENTENCES[voiceLanguageOf(locale)];
  const summary = s.summary(s.controllers(facts.controllerCount), s.robots(facts.robotCount), facts.cpuLoad, facts.memoryUsage, facts.uptime);
  if (facts.robotId === undefined) return summary;
  const note = facts.robotRegistered ? s.registered(facts.robotId) : s.notRegistered(facts.robotId);
  const news = facts.robotRegistered && facts.robotNews ? s.news(facts.robotNews) : "";
  return note + news + summary;
}

// ---------------------------------------------------------------------------
// How a node or a motor is doing, from the verdicts of the anomaly detector
// ---------------------------------------------------------------------------
/** "normal", "no_signal", "stale", "suspect" and "anomalous" are the verdicts; "unknown" is a node no verdict names; "off" is a server that does not read the verdicts. */
export type NodeState = "normal" | "no_signal" | "stale" | "suspect" | "anomalous" | "unknown" | "off";

const NODE_SENTENCES: Record<VoiceLanguage, Record<NodeState, (node: string) => string>> = {
  en: {
    normal: (n) => `${n} is behaving normally.`, suspect: (n) => `${n} looks suspect: its vibration is close to the limit.`, anomalous: (n) => `${n} is behaving abnormally.`,
    no_signal: (n) => `${n} gives no signal: it cannot be judged.`, stale: (n) => `The verdict of ${n} is out of date: no new data is arriving.`,
    unknown: (n) => `There is no verdict for ${n}.`, off: () => "This server does not read the verdicts of the anomaly detector.",
  },
  es: {
    normal: (n) => `${n} funciona con normalidad.`, suspect: (n) => `${n} resulta sospechoso: su vibración está cerca del límite.`, anomalous: (n) => `${n} funciona de forma anómala.`,
    no_signal: (n) => `${n} no da señal: no se puede juzgar.`, stale: (n) => `El veredicto de ${n} está desfasado: no llegan datos nuevos.`,
    unknown: (n) => `No hay veredicto para ${n}.`, off: () => "Este servidor no lee los veredictos del detector de anomalías.",
  },
  de: {
    normal: (n) => `${n} verhält sich normal.`, suspect: (n) => `${n} wirkt verdächtig: Die Vibration liegt nahe am Grenzwert.`, anomalous: (n) => `${n} verhält sich auffällig.`,
    no_signal: (n) => `${n} liefert kein Signal: Es lässt sich nicht beurteilen.`, stale: (n) => `Das Urteil für ${n} ist veraltet: Es kommen keine neuen Daten an.`,
    unknown: (n) => `Für ${n} gibt es kein Urteil.`, off: () => "Dieser Server liest die Urteile des Anomaliedetektors nicht.",
  },
  fr: {
    normal: (n) => `${n} se comporte normalement.`, suspect: (n) => `${n} semble suspect : sa vibration est proche de la limite.`, anomalous: (n) => `${n} se comporte de façon anormale.`,
    no_signal: (n) => `${n} ne donne aucun signal : il est impossible de juger.`, stale: (n) => `Le verdict de ${n} est périmé : aucune nouvelle donnée n'arrive.`,
    unknown: (n) => `Il n'y a pas de verdict pour ${n}.`, off: () => "Ce serveur ne lit pas les verdicts du détecteur d'anomalies.",
  },
  it: {
    normal: (n) => `${n} si comporta normalmente.`, suspect: (n) => `${n} appare sospetto: la vibrazione è vicina al limite.`, anomalous: (n) => `${n} si comporta in modo anomalo.`,
    no_signal: (n) => `${n} non dà segnale: non si può giudicare.`, stale: (n) => `Il verdetto di ${n} è superato: non arrivano dati nuovi.`,
    unknown: (n) => `Non c'è nessun verdetto per ${n}.`, off: () => "Questo server non legge i verdetti del rilevatore di anomalie.",
  },
  ja: {
    normal: (n) => `${n}は正常に動作しています。`, suspect: (n) => `${n}は疑わしい状態です。振動が限界に近づいています。`, anomalous: (n) => `${n}は異常な動作をしています。`,
    no_signal: (n) => `${n}の信号がありません。判定できません。`, stale: (n) => `${n}の判定は古くなっています。新しいデータが届いていません。`,
    unknown: (n) => `${n}の判定はありません。`, off: () => "このサーバーは異常検知の判定を読み取っていません。",
  },
  zh: {
    normal: (n) => `${n} 运行正常。`, suspect: (n) => `${n} 有可疑迹象：振动接近限值。`, anomalous: (n) => `${n} 运行异常。`,
    no_signal: (n) => `${n} 没有信号，无法判断。`, stale: (n) => `${n} 的判定已过期：没有新数据到达。`,
    unknown: (n) => `没有 ${n} 的判定结果。`, off: () => "此服务器不读取异常检测器的判定结果。",
  },
  pt: {
    normal: (n) => `${n} está a funcionar normalmente.`, suspect: (n) => `${n} parece suspeito: a vibração está perto do limite.`, anomalous: (n) => `${n} está a funcionar de forma anómala.`,
    no_signal: (n) => `${n} não dá sinal: não é possível avaliar.`, stale: (n) => `O veredicto de ${n} está desatualizado: não chegam dados novos.`,
    unknown: (n) => `Não há veredicto para ${n}.`, off: () => "Este servidor não lê os veredictos do detetor de anomalias.",
  },
};

export function nodeStateText(node: string, state: NodeState, locale: unknown): string {
  return NODE_SENTENCES[voiceLanguageOf(locale)][state](node);
}
