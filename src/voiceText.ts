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
}

const english = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const SENTENCES: Record<VoiceLanguage, StatusSentences> = {
  en: {
    controllers: (n) => english(n, "controller", "controllers"),
    robots: (n) => english(n, "robot", "robots"),
    summary: (c, r, cpu, mem, up) => `${c}, ${r} configured. CPU load ${cpu}%, memory ${mem}%, uptime ${up}s.`,
    registered: (id) => `Robot ${id} is registered on this Server. `,
    notRegistered: (id) => `Robot ${id} is not registered on this Server. `,
  },
  es: {
    controllers: (n) => english(n, "controlador", "controladores"),
    robots: (n) => english(n, "robot", "robots"),
    summary: (c, r, cpu, mem, up) => `${c} y ${r} configurados. Carga de CPU ${cpu}%, memoria ${mem}%, tiempo activo ${up}s.`,
    registered: (id) => `El robot ${id} está registrado en este servidor. `,
    notRegistered: (id) => `El robot ${id} no está registrado en este servidor. `,
  },
  de: {
    controllers: (n) => english(n, "Controller", "Controller"),
    robots: (n) => english(n, "Roboter", "Roboter"),
    summary: (c, r, cpu, mem, up) => `${c} und ${r} konfiguriert. CPU-Last ${cpu}%, Speicher ${mem}%, Laufzeit ${up}s.`,
    registered: (id) => `Roboter ${id} ist auf diesem Server registriert. `,
    notRegistered: (id) => `Roboter ${id} ist auf diesem Server nicht registriert. `,
  },
  fr: {
    controllers: (n) => english(n, "contrôleur", "contrôleurs"),
    robots: (n) => english(n, "robot", "robots"),
    summary: (c, r, cpu, mem, up) => `${c} et ${r} configurés. Charge CPU ${cpu} %, mémoire ${mem} %, durée de fonctionnement ${up} s.`,
    registered: (id) => `Le robot ${id} est enregistré sur ce serveur. `,
    notRegistered: (id) => `Le robot ${id} n'est pas enregistré sur ce serveur. `,
  },
  it: {
    controllers: (n) => english(n, "controller", "controller"),
    robots: (n) => english(n, "robot", "robot"),
    summary: (c, r, cpu, mem, up) => `${c} e ${r} configurati. Carico CPU ${cpu}%, memoria ${mem}%, tempo di attività ${up}s.`,
    registered: (id) => `Il robot ${id} è registrato su questo server. `,
    notRegistered: (id) => `Il robot ${id} non è registrato su questo server. `,
  },
  ja: {
    controllers: (n) => `コントローラ${n}台`,
    robots: (n) => `ロボット${n}台`,
    summary: (c, r, cpu, mem, up) => `${c}、${r}が設定されています。CPU負荷${cpu}%、メモリ${mem}%、稼働時間${up}秒。`,
    registered: (id) => `ロボット${id}はこのサーバーに登録されています。`,
    notRegistered: (id) => `ロボット${id}はこのサーバーに登録されていません。`,
  },
  zh: {
    controllers: (n) => `${n} 个控制器`,
    robots: (n) => `${n} 个机器人`,
    summary: (c, r, cpu, mem, up) => `已配置 ${c}、${r}。CPU 负载 ${cpu}%，内存 ${mem}%，运行时间 ${up} 秒。`,
    registered: (id) => `机器人 ${id} 已在此服务器上注册。`,
    notRegistered: (id) => `机器人 ${id} 未在此服务器上注册。`,
  },
  pt: {
    controllers: (n) => english(n, "controlador", "controladores"),
    robots: (n) => english(n, "robô", "robôs"),
    summary: (c, r, cpu, mem, up) => `${c} e ${r} configurados. Carga do CPU ${cpu}%, memória ${mem}%, tempo de atividade ${up}s.`,
    registered: (id) => `O robô ${id} está registado neste servidor. `,
    notRegistered: (id) => `O robô ${id} não está registado neste servidor. `,
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
}

export function voiceStatusText(facts: VoiceStatusFacts, locale: unknown): string {
  const s = SENTENCES[voiceLanguageOf(locale)];
  const summary = s.summary(s.controllers(facts.controllerCount), s.robots(facts.robotCount), facts.cpuLoad, facts.memoryUsage, facts.uptime);
  if (facts.robotId === undefined) return summary;
  const note = facts.robotRegistered ? s.registered(facts.robotId) : s.notRegistered(facts.robotId);
  return note + summary;
}
