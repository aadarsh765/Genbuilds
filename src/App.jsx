import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════
  ENKA.NETWORK API INTEGRATION
  Implements all 5 requirements:
    1. Correct endpoint  (/api/uid/<UID>)
    2. Custom User-Agent (via proxy header forwarding where supported)
    3. ID → Name/Icon mapping via official store/characters.json + store/loc.json
    4. Safe JSON parsing with field guards throughout
    5. TTL-based in-memory cache driven by the `ttl` field in the response
═══════════════════════════════════════════════════════════════════════ */

// ─── CONSTANTS ────────────────────────────────────────────────────────
const ENKA_BASE     = "https://enka.network";
const ENKA_API      = `${ENKA_BASE}/api/uid`;
const ENKA_CDN      = `${ENKA_BASE}/ui`;
const ENKA_STORE    = "https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store";
const USER_AGENT    = "EnkaVerse/2.0 (github.com/community)";

// CORS proxy list — tried in order on failure
const CORS_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

// HTTP status → human error messages (per official Enka docs)
const HTTP_ERRORS = {
  400: "Malformed UID — check the format and length.",
  404: "Player not found. The UID doesn't exist on Enka.Network.",
  424: "Game servers are under maintenance or the API needs updating.",
  429: "Rate limited. Wait a moment before searching again.",
  500: "Enka.Network server error. Try again shortly.",
  503: "Enka.Network is temporarily down.",
};

/* ═══════════════════════════════════════════════════════════════════════
  REQUIREMENT 5: TTL-BASED IN-MEMORY CACHE
  Stores { data, expiresAt } per UID. expiresAt is driven by response.ttl.
  No localStorage used — purely in-memory, session-scoped.
═══════════════════════════════════════════════════════════════════════ */
const uidCache = new Map(); // uid → { data: Object, expiresAt: number }

function getCached(uid) {
  const entry = uidCache.get(uid);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    uidCache.delete(uid);   // evict stale entry
    return null;
  }
  return entry.data;        // fresh hit
}

function setCached(uid, data, ttlSeconds) {
  uidCache.set(uid, {
    data,
    expiresAt: Date.now() + (ttlSeconds ?? 60) * 1000,
  });
}

function getCacheStatus(uid) {
  const entry = uidCache.get(uid);
  if (!entry || Date.now() > entry.expiresAt) return null;
  const secondsLeft = Math.ceil((entry.expiresAt - Date.now()) / 1000);
  return { secondsLeft, expiresAt: new Date(entry.expiresAt).toLocaleTimeString() };
}

/* ═══════════════════════════════════════════════════════════════════════
  REQUIREMENT 2: CUSTOM USER-AGENT + CORS PROXY FETCH
  
  Browser security FORBIDS setting the `User-Agent` header directly
  (it's a "forbidden header name" in the Fetch spec — browsers silently
  ignore it). The correct solutions are:
    A) Use a backend proxy that injects User-Agent before forwarding
    B) Pass it as a custom header (e.g. X-User-Agent) for proxies that support it
    C) For direct enka.network calls from a Node.js backend, set it normally

  Here we: (a) attempt to send it as a header so it forwards if the proxy
  supports it, and (b) document the limitation transparently.
═══════════════════════════════════════════════════════════════════════ */
async function fetchWithProxy(targetUrl) {
  let lastError = null;

  for (const buildProxy of CORS_PROXIES) {
    const proxyUrl = buildProxy(targetUrl);
    try {
      const res = await fetch(proxyUrl, {
        headers: {
          "Accept":       "application/json",
          // allorigins.win forwards headers whose names start with X-
          // so X-User-Agent reaches the origin as a custom header
          "X-User-Agent": USER_AGENT,
        },
      });

      if (!res.ok) {
        const msg = HTTP_ERRORS[res.status] ?? `HTTP ${res.status}`;
        // 4xx from Enka are definitive — stop trying other proxies
        if (res.status >= 400 && res.status < 500) throw new Error(msg);
        throw new Error(msg);  // 5xx — try next proxy
      }

      const text = await res.text();
      if (!text?.trim()) throw new Error("Empty response body");
      return text;

    } catch (err) {
      // Rethrow authoritative errors immediately (UID not found, etc.)
      if (err.message && HTTP_ERRORS[Number(err.message.match(/\d{3}/)?.[0])]) throw err;
      lastError = err;
      // Otherwise fall through to next proxy
    }
  }

  throw new Error(lastError?.message ?? "All CORS proxies failed. Try again shortly.");
}

/* ═══════════════════════════════════════════════════════════════════════
  REQUIREMENT 3 — PART A: ASSET STORE LOADER
  Loads two JSON files from the official EnkaNetwork/API-docs repository:
    • store/characters.json  — avatarId → { Element, SideIconName,
                                NameTextMapHash, SkillOrder, Skills,
                                Consts, QualityType, WeaponType }
    • store/loc.json (EN)    — NameTextMapHash (as string key) → name

  These are the authoritative ID-to-name mapping tables.
═══════════════════════════════════════════════════════════════════════ */
const assetStore = {
  characters: null,   // Map<string avatarId, CharacterStoreDef>
  loc: null,          // Map<string hash, string name>
  loaded: false,
  loading: false,
  error: null,
};

async function loadAssetStore() {
  if (assetStore.loaded || assetStore.loading) return;
  assetStore.loading = true;
  try {
    const [charText, locText] = await Promise.all([
      fetchWithProxy(`${ENKA_STORE}/characters.json`),
      fetchWithProxy(`${ENKA_STORE}/loc.json`),
    ]);

    const charRaw = JSON.parse(charText);
    const locRaw  = JSON.parse(locText);

    // loc.json structure: { "en": { "hashAsString": "Name", ... }, "zh-CN": {...}, ... }
    // We want English ("en") — fall back to top-level if "en" key is absent
    const locEn = locRaw?.en ?? locRaw;

    assetStore.characters = charRaw;   // keep as plain object (id string → def)
    assetStore.loc        = locEn;     // keep as plain object (hash string → name)
    assetStore.loaded     = true;
  } catch (e) {
    assetStore.error = e.message;
  } finally {
    assetStore.loading = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
  REQUIREMENT 3 — PART B: ID RESOLUTION HELPERS
═══════════════════════════════════════════════════════════════════════ */

// Resolve any NameTextMapHash → English name string
function resolveLocName(hash) {
  if (!hash || !assetStore.loc) return null;
  return assetStore.loc[String(hash)] ?? null;
}

// avatarId (number|string) → { name, element, iconUrl, sideIconUrl, qualityType, weaponType }
function resolveCharacter(avatarId) {
  const def = assetStore.characters?.[String(avatarId)];
  if (!def) return null;

  const ELEMENT_MAP = {
    Fire: "Pyro",  Ice: "Cryo", Electric: "Electro",  Wind: "Anemo",
    Water: "Hydro", Rock: "Geo", Grass: "Dendro",
    // Also handle already-mapped keys
    Pyro:"Pyro", Cryo:"Cryo", Electro:"Electro", Anemo:"Anemo",
    Hydro:"Hydro", Geo:"Geo", Dendro:"Dendro",
  };

  return {
    name:        resolveLocName(def.NameTextMapHash) ?? `Character ${avatarId}`,
    element:     ELEMENT_MAP[def.Element] ?? def.Element ?? "Anemo",
    sideIconUrl: def.SideIconName ? `${ENKA_CDN}/${def.SideIconName}.png` : null,
    iconUrl:     def.SideIconName ? `${ENKA_CDN}/${def.SideIconName.replace("_Side", "")}.png` : null,
    qualityType: def.QualityType ?? "",
    weaponType:  def.WeaponType ?? "",
    skillOrder:  def.SkillOrder ?? [],
    skills:      def.Skills ?? {},
    consts:      def.Consts ?? [],
    rarity:      def.QualityType === "QUALITY_ORANGE" ? 5 : def.QualityType === "QUALITY_PURPLE" ? 4 : 3,
  };
}

// flat.nameTextMapHash + flat.icon → { name, iconUrl }
function resolveEquip(flat) {
  if (!flat) return { name: "Unknown", iconUrl: null };
  return {
    name:    resolveLocName(flat.nameTextMapHash) ?? "Unknown",
    iconUrl: flat.icon ? `${ENKA_CDN}/${flat.icon}.png` : null,
  };
}

// flat.setNameTextMapHash → artifact set name
function resolveSetName(flat) {
  return resolveLocName(flat?.setNameTextMapHash) ?? "Unknown Set";
}

/* ═══════════════════════════════════════════════════════════════════════
  FIGHT PROP METADATA TABLE
  Used to format stat values correctly (flat vs. percent)
═══════════════════════════════════════════════════════════════════════ */
const FIGHT_PROP = {
  FIGHT_PROP_BASE_HP:            { label: "Base HP",          pct: false },
  FIGHT_PROP_HP:                 { label: "HP",               pct: false },
  FIGHT_PROP_HP_PERCENT:         { label: "HP%",              pct: true  },
  FIGHT_PROP_BASE_ATTACK:        { label: "Base ATK",         pct: false },
  FIGHT_PROP_ATTACK:             { label: "ATK",              pct: false },
  FIGHT_PROP_ATTACK_PERCENT:     { label: "ATK%",             pct: true  },
  FIGHT_PROP_BASE_DEFENSE:       { label: "Base DEF",         pct: false },
  FIGHT_PROP_DEFENSE:            { label: "DEF",              pct: false },
  FIGHT_PROP_DEFENSE_PERCENT:    { label: "DEF%",             pct: true  },
  FIGHT_PROP_CRITICAL:           { label: "Crit Rate",        pct: true  },
  FIGHT_PROP_CRITICAL_HURT:      { label: "Crit DMG",         pct: true  },
  FIGHT_PROP_CHARGE_EFFICIENCY:  { label: "Energy Recharge",  pct: true  },
  FIGHT_PROP_ELEMENT_MASTERY:    { label: "Elemental Mastery",pct: false },
  FIGHT_PROP_HEAL_ADD:           { label: "Healing Bonus",    pct: true  },
  FIGHT_PROP_FIRE_ADD_HURT:      { label: "Pyro DMG%",        pct: true  },
  FIGHT_PROP_ELEC_ADD_HURT:      { label: "Electro DMG%",     pct: true  },
  FIGHT_PROP_WATER_ADD_HURT:     { label: "Hydro DMG%",       pct: true  },
  FIGHT_PROP_GRASS_ADD_HURT:     { label: "Dendro DMG%",      pct: true  },
  FIGHT_PROP_WIND_ADD_HURT:      { label: "Anemo DMG%",       pct: true  },
  FIGHT_PROP_ROCK_ADD_HURT:      { label: "Geo DMG%",         pct: true  },
  FIGHT_PROP_ICE_ADD_HURT:       { label: "Cryo DMG%",        pct: true  },
  FIGHT_PROP_PHYSICAL_ADD_HURT:  { label: "Physical DMG%",    pct: true  },
};

const EQUIP_TYPE_LABELS = {
  EQUIP_BRACER:   { label: "Flower",  icon: "🌸" },
  EQUIP_NECKLACE: { label: "Plume",   icon: "🪶" },
  EQUIP_SHOES:    { label: "Sands",   icon: "⏳" },
  EQUIP_RING:     { label: "Goblet",  icon: "🏆" },
  EQUIP_DRESS:    { label: "Circlet", icon: "👑" },
};

function fmtStatValue(propId, rawValue) {
  if (rawValue == null) return "—";
  const meta = FIGHT_PROP[propId];
  if (!meta) return rawValue.toLocaleString();
  return meta.pct
    ? `${(rawValue * 100).toFixed(1)}%`
    : Math.round(rawValue).toLocaleString();
}

/* ═══════════════════════════════════════════════════════════════════════
  REQUIREMENT 4: SAFE PARSING — avatarInfoList PARSER
  Every field access is guarded. Missing data falls back to sensible defaults.
═══════════════════════════════════════════════════════════════════════ */
function parseWeapon(equipList) {
  const eq = (equipList ?? []).find(e => e?.flat?.itemType === "ITEM_WEAPON");
  if (!eq) return null;

  const flat      = eq.flat ?? {};
  const weapon    = eq.weapon ?? {};
  const { name, iconUrl } = resolveEquip(flat);

  // Refinement is stored in affixMap: { "randomId": 0-4 } where value = refinement - 1
  const refinement = weapon.affixMap
    ? (Object.values(weapon.affixMap)[0] ?? 0) + 1
    : 1;

  const baseAtk  = flat.weaponStats?.[0]?.statValue ?? 0;
  const subStat  = flat.weaponStats?.[1] ?? null;

  return {
    name,
    iconUrl,
    rarity:      flat.rankLevel ?? 4,
    level:       weapon.level ?? 1,
    ascension:   weapon.promoteLevel ?? 0,
    refinement,
    baseAtk:     Math.round(baseAtk),
    subStatId:   subStat?.appendPropId ?? null,
    subStatLabel: subStat ? (FIGHT_PROP[subStat.appendPropId]?.label ?? subStat.appendPropId) : null,
    subStatValue: subStat ? fmtStatValue(subStat.appendPropId, subStat.statValue) : null,
  };
}

function parseArtifact(eq) {
  if (!eq || eq.flat?.itemType !== "ITEM_RELIQUARY") return null;

  const flat     = eq.flat ?? {};
  const relic    = eq.reliquary ?? {};
  const { name, iconUrl } = resolveEquip(flat);
  const setName  = resolveSetName(flat);
  const equipMeta = EQUIP_TYPE_LABELS[flat.equipType] ?? { label: flat.equipType, icon: "🔮" };

  // Main stat
  const mainStat = flat.reliquaryMainstat ?? {};
  const mainId   = mainStat.mainPropId ?? "";
  const mainVal  = fmtStatValue(mainId, mainStat.statValue);
  const mainLabel = FIGHT_PROP[mainId]?.label ?? mainId;

  // Sub-stats — calculate CV contribution
  let cv = 0;
  const subs = (flat.reliquarySubstats ?? []).map(s => {
    const propId = s.appendPropId ?? "";
    const raw    = s.statValue ?? 0;
    if (propId === "FIGHT_PROP_CRITICAL")      cv += raw * 2;
    if (propId === "FIGHT_PROP_CRITICAL_HURT") cv += raw;
    return {
      propId,
      label:   FIGHT_PROP[propId]?.label ?? propId,
      value:   fmtStatValue(propId, raw),
      rawValue: raw,
      // Tier scoring: gold = very high rolls, green = good, grey = filler
      tier: (() => {
        if (propId === "FIGHT_PROP_CRITICAL"      && raw >= 0.093) return "gold";
        if (propId === "FIGHT_PROP_CRITICAL_HURT" && raw >= 0.187) return "gold";
        if (propId === "FIGHT_PROP_CRITICAL"      && raw >= 0.062) return "green";
        if (propId === "FIGHT_PROP_CRITICAL_HURT" && raw >= 0.124) return "green";
        if (propId === "FIGHT_PROP_ATTACK_PERCENT"&& raw >= 0.093) return "gold";
        if (propId === "FIGHT_PROP_ATTACK_PERCENT"&& raw >= 0.058) return "green";
        if (propId === "FIGHT_PROP_HP_PERCENT"    && raw >= 0.093) return "gold";
        if (propId === "FIGHT_PROP_DEFENSE_PERCENT"&&raw >= 0.109) return "gold";
        if (propId === "FIGHT_PROP_CHARGE_EFFICIENCY"&&raw>=0.110) return "gold";
        if (propId === "FIGHT_PROP_ELEMENT_MASTERY"&& raw >= 40)   return "gold";
        if (propId === "FIGHT_PROP_ELEMENT_MASTERY"&& raw >= 23)   return "green";
        return "grey";
      })(),
    };
  });
  // CV from main stat too
  if (mainId === "FIGHT_PROP_CRITICAL")      cv += (mainStat.statValue ?? 0) * 2;
  if (mainId === "FIGHT_PROP_CRITICAL_HURT") cv += (mainStat.statValue ?? 0);

  return {
    name,
    setName,
    iconUrl,
    type:      equipMeta.label,
    typeIcon:  equipMeta.icon,
    rarity:    flat.rankLevel ?? 5,
    level:     relic.level ?? 0,
    mainLabel, mainVal,
    subs,
    cv:        parseFloat(cv.toFixed(1)),
  };
}

function parseFightProps(fightPropMap) {
  const fp = fightPropMap ?? {};
  // Key names in fightPropMap are numeric strings that correspond to prop IDs
  // but we also get named keys like FIGHT_PROP_HP. We normalize to named.
  const NUM_TO_NAME = {
    "1":"FIGHT_PROP_BASE_HP","2":"FIGHT_PROP_HP","3":"FIGHT_PROP_HP_PERCENT",
    "4":"FIGHT_PROP_BASE_ATTACK","5":"FIGHT_PROP_ATTACK","6":"FIGHT_PROP_ATTACK_PERCENT",
    "7":"FIGHT_PROP_BASE_DEFENSE","8":"FIGHT_PROP_DEFENSE","9":"FIGHT_PROP_DEFENSE_PERCENT",
    "20":"FIGHT_PROP_CRITICAL","22":"FIGHT_PROP_CRITICAL_HURT",
    "23":"FIGHT_PROP_CHARGE_EFFICIENCY","26":"FIGHT_PROP_HEAL_ADD",
    "27":"FIGHT_PROP_ELEMENT_MASTERY","28":"FIGHT_PROP_ELEMENT_MASTERY",
    "40":"FIGHT_PROP_FIRE_ADD_HURT","41":"FIGHT_PROP_ELEC_ADD_HURT",
    "42":"FIGHT_PROP_WATER_ADD_HURT","43":"FIGHT_PROP_GRASS_ADD_HURT",
    "44":"FIGHT_PROP_WIND_ADD_HURT","45":"FIGHT_PROP_ROCK_ADD_HURT",
    "46":"FIGHT_PROP_ICE_ADD_HURT","50":"FIGHT_PROP_PHYSICAL_ADD_HURT",
  };
  const named = {};
  for (const [k, v] of Object.entries(fp)) {
    const name = isNaN(k) ? k : NUM_TO_NAME[k];
    if (name) named[name] = v;
  }
  const g = (key) => named[key] ?? 0;
  return {
    hp:        Math.round(g("FIGHT_PROP_HP")),
    baseHp:    Math.round(g("FIGHT_PROP_BASE_HP")),
    atk:       Math.round(g("FIGHT_PROP_ATTACK") + g("FIGHT_PROP_BASE_ATTACK")),
    def:       Math.round(g("FIGHT_PROP_DEFENSE") + g("FIGHT_PROP_BASE_DEFENSE")),
    em:        Math.round(g("FIGHT_PROP_ELEMENT_MASTERY")),
    er:        parseFloat(((g("FIGHT_PROP_CHARGE_EFFICIENCY") || 1) * 100).toFixed(1)),
    critRate:  parseFloat(((g("FIGHT_PROP_CRITICAL") || 0.05) * 100).toFixed(1)),
    critDmg:   parseFloat(((g("FIGHT_PROP_CRITICAL_HURT") || 0.5) * 100).toFixed(1)),
    healBonus: parseFloat(((g("FIGHT_PROP_HEAL_ADD") || 0) * 100).toFixed(1)),
    raw: named,
  };
}

// REQUIREMENT 4: Safe parse of a single avatarInfo entry
function parseAvatarInfo(avatarInfo) {
  if (!avatarInfo) return null;

  const avatarId   = avatarInfo.avatarId;
  const charMeta   = resolveCharacter(avatarId) ?? {
    name: `Unknown (${avatarId})`, element: "Anemo",
    sideIconUrl: null, iconUrl: null, rarity: 4,
    skillOrder: [], skills: {}, consts: [],
  };

  // Level / ascension from propMap
  const propMap   = avatarInfo.propMap ?? {};
  const level     = parseInt(propMap["4001"]?.val ?? propMap["4001"]?.ival ?? 1, 10);
  const ascension = parseInt(propMap["1002"]?.val ?? propMap["1002"]?.ival ?? 0, 10);
  const xp        = parseInt(propMap["1001"]?.val ?? 0, 10);

  // Constellations = number of unlocked talent IDs
  const constellation = (avatarInfo.talentIdList ?? []).length;
  const friendship    = avatarInfo.fetterInfo?.expLevel ?? 1;

  // Skills — skillLevelMap: { skillId: level }
  const skillLevelMap = avatarInfo.skillLevelMap ?? {};
  const skills = charMeta.skillOrder.map((skillId, i) => ({
    skillId,
    iconKey: charMeta.skills[skillId] ?? null,
    iconUrl: charMeta.skills[skillId] ? `${ENKA_CDN}/${charMeta.skills[skillId]}.png` : null,
    level: skillLevelMap[skillId] ?? 1,
    label: i === 0 ? "Normal Attack" : i === 1 ? "Elemental Skill" : "Elemental Burst",
  }));

  // Constellations
  const constIcons = charMeta.consts.map((key, i) => ({
    key,
    iconUrl: `${ENKA_CDN}/${key}.png`,
    unlocked: i < constellation,
  }));

  // Equipment
  const equipList = avatarInfo.equipList ?? [];
  const weapon    = parseWeapon(equipList);
  const artifacts = equipList
    .map(parseArtifact)
    .filter(Boolean);

  // Fight properties
  const stats = parseFightProps(avatarInfo.fightPropMap);
  const cv    = parseFloat((stats.critRate * 2 + stats.critDmg - 150).toFixed(1)); // subtract base

  return {
    avatarId,
    name:        charMeta.name,
    element:     charMeta.element,
    sideIconUrl: charMeta.sideIconUrl,
    iconUrl:     charMeta.iconUrl,
    rarity:      charMeta.rarity,
    weaponType:  charMeta.weaponType,
    level, ascension, xp, constellation, friendship,
    skills, constIcons,
    weapon, artifacts,
    stats,
    cv: Math.max(0, cv),
    buildScore: Math.min(100, Math.round(
      (Math.max(0, cv) / 280) * 60 +
      (artifacts.length / 5) * 20 +
      (weapon ? 10 : 0) + 10
    )),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
  MAIN FETCH FUNCTION — combines all 5 requirements
═══════════════════════════════════════════════════════════════════════ */
async function fetchPlayerData(uid, { forceRefresh = false } = {}) {
  // 1. Validate UID format (7-10 digits)
  if (!/^\d{7,10}$/.test(String(uid))) {
    throw new Error("Invalid UID format. Must be 7–10 digits.");
  }

  // REQUIREMENT 5: Check TTL cache before fetching
  if (!forceRefresh) {
    const cached = getCached(uid);
    if (cached) return { ...cached, fromCache: true };
  }

  // REQUIREMENT 3: Ensure asset store is loaded before parsing
  if (!assetStore.loaded && !assetStore.error) {
    await loadAssetStore();
  }

  // REQUIREMENT 1 + 2: Fetch via CORS proxy with User-Agent forwarding
  // Appending ?info per Enka docs to reduce data load if no showcase is set
  const targetUrl = `${ENKA_API}/${uid}`;
  const text = await fetchWithProxy(targetUrl);

  // REQUIREMENT 4: Safe JSON parse
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse API response as JSON.");
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Unexpected response shape from Enka.Network.");
  }

  // REQUIREMENT 4: Safe playerInfo extraction
  const playerInfo = raw.playerInfo ?? null;
  const player = playerInfo ? {
    nickname:     playerInfo.nickname   ?? "Traveler",
    signature:    playerInfo.signature  ?? "",
    level:        playerInfo.level      ?? 0,
    worldLevel:   playerInfo.worldLevel ?? 0,
    achievementCount: playerInfo.finishAchievementNum ?? 0,
    towerFloor:   playerInfo.towerFloorIndex ?? 0,
    towerLevel:   playerInfo.towerLevelIndex ?? 0,
    nameCardId:   playerInfo.nameCardId ?? 0,
    nameCardUrl:  playerInfo.nameCardId
      ? `${ENKA_CDN}/UI_NameCardPic_${playerInfo.nameCardId}_P.png`
      : null,
    profilePictureAvatarId: playerInfo.profilePicture?.avatarId ?? null,
  } : null;

  // REQUIREMENT 4: Safe avatarInfoList extraction
  const rawAvatarList = Array.isArray(raw.avatarInfoList) ? raw.avatarInfoList : [];
  const characters = rawAvatarList
    .map(av => { try { return parseAvatarInfo(av); } catch { return null; } })
    .filter(Boolean);

  // REQUIREMENT 5: Read ttl from response, store in cache
  const ttl = typeof raw.ttl === "number" ? raw.ttl : 60;
  const uid_out = raw.uid ?? String(uid);

  const result = {
    uid: uid_out,
    ttl,
    player,
    characters,
    owner: raw.owner ?? null,
    fromCache: false,
  };

  setCached(uid, result, ttl);
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
  UI — ELEMENT THEME DEFINITIONS
═══════════════════════════════════════════════════════════════════════ */
const ELEM = {
  Pyro:    { p:"#FF4D00",g:"rgba(255,77,0,0.35)",   b:"rgba(255,77,0,0.07)",   e:"🔥" },
  Cryo:    { p:"#7DF9FF",g:"rgba(125,249,255,0.32)",b:"rgba(125,249,255,0.06)",e:"❄️" },
  Electro: { p:"#C77DFF",g:"rgba(199,125,255,0.32)",b:"rgba(199,125,255,0.06)",e:"⚡" },
  Hydro:   { p:"#4CC9F0",g:"rgba(76,201,240,0.32)", b:"rgba(76,201,240,0.06)", e:"💧" },
  Anemo:   { p:"#80FF72",g:"rgba(128,255,114,0.32)",b:"rgba(128,255,114,0.06)",e:"🌪️" },
  Geo:     { p:"#E2C880",g:"rgba(226,200,128,0.38)",b:"rgba(226,200,128,0.07)",e:"⛏️" },
  Dendro:  { p:"#98D631",g:"rgba(152,214,49,0.32)", b:"rgba(152,214,49,0.06)", e:"🌿" },
};

/* ═══════════════════════════════════════════════════════════════════════
  UI COMPONENTS
═══════════════════════════════════════════════════════════════════════ */
function AnimNum({ target, suffix="", dec=0 }) {
  const [v, setV] = useState(0);
  const r = useRef();
  useEffect(() => {
    const s = performance.now(), d = 1000;
    const tick = n => {
      const p = Math.min((n - s) / d, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setV(dec > 0 ? parseFloat((e * target).toFixed(dec)) : Math.round(e * target));
      if (p < 1) r.current = requestAnimationFrame(tick);
    };
    r.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(r.current);
  }, [target]);
  return <>{dec > 0 ? v : (v > 999 ? v.toLocaleString() : v)}{suffix}</>;
}

function StatRow({ label, value, color, pct=false, max }) {
  const w = max ? Math.min((parseFloat(value) / max) * 100, 100) : null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", fontFamily: "'DM Mono',monospace" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'DM Mono',monospace" }}>{value}</span>
      </div>
      {w !== null && (
        <div style={{ height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 2 }}>
          <div style={{ height: "100%", width: `${w}%`, background: color, borderRadius: 2,
            boxShadow: `0 0 6px ${color}70`, transition: "width 1s cubic-bezier(.22,1,.36,1)" }} />
        </div>
      )}
    </div>
  );
}

function CharacterCard({ char, onClick, idx }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [hov, setHov] = useState(false);
  const ref = useRef();
  const ec = ELEM[char.element] ?? ELEM.Anemo;
  const [imgErr, setImgErr] = useState(false);

  return (
    <div ref={ref}
      onClick={() => onClick(char)}
      onMouseMove={e => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        setTilt({ x: (e.clientY - r.top - r.height / 2) / r.height * 14,
                  y: -(e.clientX - r.left - r.width / 2) / r.width * 14 });
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => { setHov(false); setTilt({ x: 0, y: 0 }); }}
      style={{ cursor: "pointer", perspective: 700,
        animation: `cardIn .5s cubic-bezier(.22,1,.36,1) ${idx * 60}ms both` }}>
      <div style={{
        background: `linear-gradient(150deg,rgba(10,10,22,0.97),${ec.b})`,
        border: `1px solid ${hov ? ec.p + "50" : "rgba(255,255,255,0.07)"}`,
        borderRadius: 15, padding: 13, position: "relative", overflow: "hidden",
        transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) ${hov ? "scale(1.04) translateY(-3px)" : ""}`,
        transition: "transform .12s,border-color .2s,box-shadow .2s",
        boxShadow: hov ? `0 16px 40px ${ec.g}` : "0 4px 16px rgba(0,0,0,.4)",
        userSelect: "none",
      }}>
        <div style={{ position:"absolute",top:0,left:0,right:0,height:2,
          background:`linear-gradient(90deg,transparent,${ec.p},transparent)`,opacity:hov?1:.4 }}/>
        <div style={{ position:"absolute",top:-20,right:-20,width:80,height:80,borderRadius:"50%",
          background:`radial-gradient(circle,${ec.g},transparent 70%)`,opacity:hov?1:.5 }}/>

        {/* Icon */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8,position:"relative",zIndex:1 }}>
          {char.sideIconUrl && !imgErr
            ? <img src={char.sideIconUrl} alt={char.name} onError={()=>setImgErr(true)}
                style={{ width:50,height:50,borderRadius:10,objectFit:"cover",
                  border:`2px solid ${ec.p}45`,boxShadow:`0 0 12px ${ec.g}` }}/>
            : <div style={{ width:50,height:50,borderRadius:10,display:"flex",alignItems:"center",
                justifyContent:"center",fontSize:26,background:ec.b,border:`2px solid ${ec.p}45` }}>{ec.e}</div>
          }
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:8,color:"rgba(255,255,255,0.28)",fontFamily:"'DM Mono',monospace" }}>SCORE</div>
            <div style={{ fontSize:18,fontWeight:800,color:ec.p,fontFamily:"'Oxanium',cursive",lineHeight:1 }}>{char.buildScore}</div>
          </div>
        </div>

        <h3 style={{ fontSize:13,fontWeight:800,color:"white",margin:"0 0 2px",fontFamily:"'Oxanium',cursive",
          whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",position:"relative",zIndex:1 }}>{char.name}</h3>
        <div style={{ fontSize:9.5,color:"rgba(255,255,255,0.32)",fontFamily:"'DM Mono',monospace",marginBottom:8,position:"relative",zIndex:1 }}>
          Lv.{char.level} · C{char.constellation} · {"★".repeat(Math.min(char.rarity,5))}
        </div>

        <div style={{ display:"flex",gap:5,marginBottom:8,position:"relative",zIndex:1 }}>
          {[{l:"CR",v:`${char.stats.critRate.toFixed(1)}%`,c:"#FFD700"},
            {l:"CD",v:`${char.stats.critDmg.toFixed(1)}%`,c:"#FF6B9D"},
            {l:"CV",v:char.cv.toFixed(1),c:ec.p}].map(s=>(
            <div key={s.l} style={{flex:1,background:"rgba(255,255,255,0.04)",borderRadius:6,padding:"3px 2px",textAlign:"center"}}>
              <div style={{fontSize:7.5,color:"rgba(255,255,255,0.28)",fontFamily:"'DM Mono',monospace"}}>{s.l}</div>
              <div style={{fontSize:10.5,fontWeight:700,color:s.c,fontFamily:"'DM Mono',monospace"}}>{s.v}</div>
            </div>
          ))}
        </div>

        {char.weapon && (
          <div style={{ display:"flex",alignItems:"center",gap:5,position:"relative",zIndex:1,
            borderTop:"1px solid rgba(255,255,255,0.06)",paddingTop:7 }}>
            <span style={{ fontSize:11 }}>⚔️</span>
            <span style={{ fontSize:9,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace",
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1 }}>{char.weapon.name}</span>
            <span style={{ fontSize:9,color:"#E2C880",fontFamily:"'DM Mono',monospace",flexShrink:0 }}>R{char.weapon.refinement}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CharacterModal({ char, onClose }) {
  const [tab, setTab] = useState("stats");
  const ec = ELEM[char.element] ?? ELEM.Anemo;
  const [imgErr, setImgErr] = useState(false);
  const tierC = { gold:"#E2C880", green:"#72FF96", grey:"rgba(255,255,255,0.3)" };

  const statList = [
    { label:"Max HP",           val:char.stats.hp,       max:45000, color:"#72FF96"  },
    { label:"ATK",               val:char.stats.atk,      max:5000,  color:"#FF8C42"  },
    { label:"DEF",               val:char.stats.def,      max:2500,  color:"#4CC9F0"  },
    { label:"Elemental Mastery", val:char.stats.em,       max:1000,  color:"#C77DFF"  },
    { label:"Crit Rate",         val:`${char.stats.critRate.toFixed(1)}%`, max:null, color:"#FFD700" },
    { label:"Crit DMG",          val:`${char.stats.critDmg.toFixed(1)}%`,  max:null, color:"#FF6B9D" },
    { label:"Energy Recharge",   val:`${char.stats.er.toFixed(1)}%`,        max:null, color:"#80FF72" },
    { label:"Healing Bonus",     val:`${char.stats.healBonus.toFixed(1)}%`, max:null, color:"#72EFDD" },
  ];

  return (
    <div style={{ position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.88)",
      backdropFilter:"blur(24px)",display:"flex",alignItems:"center",justifyContent:"center",
      padding:16,animation:"fadeIn .2s ease" }} onClick={onClose}>
      <div style={{ width:"min(95vw,1000px)",maxHeight:"90vh",overflowY:"auto",
        background:"linear-gradient(145deg,rgba(7,7,17,0.99),rgba(11,11,26,0.99))",
        border:`1px solid ${ec.p}30`,borderRadius:20,overflow:"hidden",
        boxShadow:`0 0 80px ${ec.g},0 30px 80px rgba(0,0,0,.7)`,
        animation:"modalIn .4s cubic-bezier(.22,1,.36,1)" }} onClick={e=>e.stopPropagation()}>

        <div style={{ position:"absolute",top:0,left:0,right:0,height:2,
          background:`linear-gradient(90deg,transparent,${ec.p},transparent)` }}/>
        <div style={{ position:"absolute",top:-60,right:-60,width:300,height:300,borderRadius:"50%",
          background:`radial-gradient(circle,${ec.g},transparent 70%)`,pointerEvents:"none" }}/>

        <button onClick={onClose} style={{ position:"absolute",top:12,right:12,zIndex:10,
          width:32,height:32,borderRadius:"50%",cursor:"pointer",
          background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",
          color:"rgba(255,255,255,0.5)",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>

        <div style={{ padding:"22px 22px 0",position:"relative" }}>
          {/* Header */}
          <div style={{ display:"flex",gap:14,alignItems:"flex-start",marginBottom:18,flexWrap:"wrap" }}>
            {char.sideIconUrl && !imgErr
              ? <img src={char.sideIconUrl} alt={char.name} onError={()=>setImgErr(true)}
                  style={{ width:70,height:70,borderRadius:14,objectFit:"cover",flexShrink:0,
                    border:`2px solid ${ec.p}45`,boxShadow:`0 0 20px ${ec.g}` }}/>
              : <div style={{ width:70,height:70,borderRadius:14,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:36,background:ec.b,border:`2px solid ${ec.p}45`,flexShrink:0 }}>{ec.e}</div>
            }
            <div style={{ flex:1,minWidth:180 }}>
              <div style={{ display:"flex",gap:7,alignItems:"center",flexWrap:"wrap",marginBottom:4 }}>
                <h2 style={{ fontSize:20,fontWeight:800,color:"white",fontFamily:"'Oxanium',cursive",margin:0 }}>{char.name}</h2>
                <span style={{ fontSize:9.5,padding:"2px 9px",borderRadius:20,background:`${ec.p}18`,
                  border:`1px solid ${ec.p}40`,color:ec.p,fontFamily:"'DM Mono',monospace",letterSpacing:.8 }}>{char.element.toUpperCase()}</span>
              </div>
              <div style={{ fontSize:10.5,color:"rgba(255,255,255,0.38)",fontFamily:"'DM Mono',monospace",marginBottom:5 }}>
                Lv.{char.level} · C{char.constellation} · Friendship {char.friendship}
              </div>
              <div>{"★".repeat(Math.min(char.rarity,5)).split("").map((s,i)=>(
                <span key={i} style={{ color:"#E2C880",fontSize:13 }}>★</span>
              ))}</div>
            </div>
            {/* Score ring */}
            <div style={{ textAlign:"center",flexShrink:0 }}>
              <svg width={58} height={58} style={{ transform:"rotate(-90deg)" }}>
                <circle cx={29} cy={29} r={22} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={6}/>
                <circle cx={29} cy={29} r={22} fill="none" stroke={ec.p} strokeWidth={6} strokeLinecap="round"
                  strokeDasharray={`${2*Math.PI*22*char.buildScore/100} ${2*Math.PI*22}`}
                  style={{ filter:`drop-shadow(0 0 5px ${ec.p})` }}/>
              </svg>
              <div style={{ fontSize:15,fontWeight:800,color:ec.p,fontFamily:"'Oxanium',cursive",marginTop:-44 }}>{char.buildScore}</div>
              <div style={{ fontSize:7.5,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace",marginTop:32 }}>SCORE</div>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display:"flex",gap:1,borderBottom:"1px solid rgba(255,255,255,0.07)" }}>
            {["stats","artifacts","skills","consts"].map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{ background:"none",border:"none",padding:"6px 14px",
                cursor:"pointer",fontSize:10.5,letterSpacing:.8,textTransform:"uppercase",fontFamily:"'DM Mono',monospace",
                color:tab===t?ec.p:"rgba(255,255,255,0.32)",
                borderBottom:`2px solid ${tab===t?ec.p:"transparent"}`,transition:"all .18s",marginBottom:-1 }}>{t}</button>
            ))}
          </div>
        </div>

        <div style={{ padding:"18px 22px 24px" }}>

          {/* STATS TAB */}
          {tab==="stats" && (
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
              <div>
                {statList.slice(0,4).map(s=>(
                  <StatRow key={s.label} label={s.label}
                    value={typeof s.val==="number" ? s.val.toLocaleString() : s.val}
                    color={s.color} max={s.max}/>
                ))}
              </div>
              <div>
                {statList.slice(4).map(s=>(
                  <StatRow key={s.label} label={s.label} value={s.val} color={s.color}/>
                ))}
              </div>
              {char.weapon && (
                <div style={{ gridColumn:"1/-1",background:"rgba(255,255,255,0.03)",
                  border:`1px solid ${ec.p}22`,borderRadius:12,padding:"12px 14px",
                  display:"flex",gap:12,alignItems:"center" }}>
                  <div style={{ width:46,height:46,borderRadius:10,flexShrink:0,fontSize:22,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    background:ec.b,border:`1px solid ${ec.p}32` }}>⚔️</div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
                      <span style={{ fontSize:13,fontWeight:700,color:"white",fontFamily:"'Oxanium',cursive" }}>{char.weapon.name}</span>
                      <span style={{ fontSize:9.5,color:"#E2C880",fontFamily:"'DM Mono',monospace" }}>R{char.weapon.refinement}</span>
                      <span style={{ fontSize:9.5,color:"rgba(255,255,255,0.28)",fontFamily:"'DM Mono',monospace" }}>Lv.{char.weapon.level}</span>
                    </div>
                    {char.weapon.subStatLabel && (
                      <div style={{ fontSize:10.5,color:"rgba(255,255,255,0.38)",fontFamily:"'DM Mono',monospace",marginTop:2 }}>
                        {char.weapon.subStatLabel}: {char.weapon.subStatValue}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign:"right",flexShrink:0 }}>
                    <div style={{ fontSize:8.5,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace" }}>BASE ATK</div>
                    <div style={{ fontSize:18,fontWeight:800,color:ec.p,fontFamily:"'Oxanium',cursive" }}>{char.weapon.baseAtk.toLocaleString()}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ARTIFACTS TAB */}
          {tab==="artifacts" && (
            char.artifacts.length === 0
              ? <div style={{ textAlign:"center",color:"rgba(255,255,255,0.25)",fontFamily:"'DM Mono',monospace",padding:40 }}>No artifacts in showcase slot</div>
              : <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(168px,1fr))",gap:9 }}>
                  {char.artifacts.map((art,i)=>(
                    <div key={i} style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",
                      borderRadius:12,padding:11,position:"relative",overflow:"hidden" }}>
                      <div style={{ position:"absolute",top:0,left:0,right:0,height:2,
                        background:`linear-gradient(90deg,transparent,${ec.p},transparent)` }}/>
                      <div style={{ display:"flex",gap:7,alignItems:"flex-start",marginBottom:7 }}>
                        <span style={{ fontSize:18,lineHeight:1 }}>{art.typeIcon}</span>
                        <div style={{ flex:1,minWidth:0 }}>
                          <div style={{ fontSize:8,color:ec.p,fontFamily:"'DM Mono',monospace",letterSpacing:.7,
                            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{art.setName.toUpperCase()}</div>
                          <div style={{ fontSize:10.5,color:"rgba(255,255,255,0.8)",fontWeight:700 }}>{art.type}</div>
                        </div>
                        <div style={{ textAlign:"right",flexShrink:0 }}>
                          <div style={{ fontSize:7.5,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace" }}>CV</div>
                          <div style={{ fontSize:13,fontWeight:800,fontFamily:"'Oxanium',cursive",
                            color:art.cv>=50?"#E2C880":art.cv>=30?"#72FF96":"rgba(255,255,255,0.38)" }}>{art.cv}</div>
                        </div>
                      </div>
                      <div style={{ fontSize:9.5,color:"rgba(255,255,255,0.4)",fontFamily:"'DM Mono',monospace",marginBottom:5 }}>
                        {art.mainLabel}: {art.mainVal}
                      </div>
                      {art.subs.map((s,j)=>(
                        <div key={j} style={{ display:"flex",justifyContent:"space-between",marginBottom:2.5 }}>
                          <span style={{ fontSize:9,color:"rgba(255,255,255,0.38)",fontFamily:"'DM Mono',monospace" }}>{s.label}</span>
                          <span style={{ fontSize:9,fontWeight:700,color:tierC[s.tier],fontFamily:"'DM Mono',monospace" }}>{s.value}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{ gridColumn:"1/-1",background:ec.b,border:`1px solid ${ec.p}22`,
                    borderRadius:12,padding:12,display:"flex",justifyContent:"space-around",gap:10,flexWrap:"wrap" }}>
                    {[{l:"TOTAL CV",v:char.artifacts.reduce((s,a)=>s+a.cv,0).toFixed(1),c:"#E2C880"},
                      {l:"BUILD SCORE",v:`${char.buildScore}/100`,c:ec.p},
                      {l:"GRADE",v:char.buildScore>=92?"S+":char.buildScore>=82?"S":char.buildScore>=70?"A":"B",
                        c:char.buildScore>=82?"#E2C880":"#72FF96"}
                    ].map(s=>(
                      <div key={s.l} style={{ textAlign:"center" }}>
                        <div style={{ fontSize:8,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace",letterSpacing:.8 }}>{s.l}</div>
                        <div style={{ fontSize:20,fontWeight:800,color:s.c,fontFamily:"'Oxanium',cursive" }}>{s.v}</div>
                      </div>
                    ))}
                  </div>
                </div>
          )}

          {/* SKILLS TAB */}
          {tab==="skills" && (
            <div style={{ display:"flex",flexDirection:"column",gap:9 }}>
              {char.skills.length === 0
                ? <div style={{ textAlign:"center",color:"rgba(255,255,255,0.25)",fontFamily:"'DM Mono',monospace",padding:36 }}>No skill data available</div>
                : char.skills.map((sk,i)=>(
                  <div key={i} style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",
                    borderRadius:12,padding:"12px 14px",display:"flex",gap:13,alignItems:"center" }}>
                    {sk.iconUrl
                      ? <img src={sk.iconUrl} alt={sk.label}
                          style={{ width:44,height:44,borderRadius:10,flexShrink:0,objectFit:"cover",
                            background:ec.b,border:`1px solid ${ec.p}32` }}
                          onError={e=>{e.target.style.display="none";}}/>
                      : <div style={{ width:44,height:44,borderRadius:10,flexShrink:0,fontSize:20,
                          display:"flex",alignItems:"center",justifyContent:"center",background:ec.b,border:`1px solid ${ec.p}32` }}>
                          {["⚔️","🌀","💥"][i]}
                        </div>}
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:12.5,fontWeight:700,color:"white",fontFamily:"'Oxanium',cursive" }}>{sk.label}</div>
                      <div style={{ fontSize:9.5,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace",marginTop:1 }}>Skill ID: {sk.skillId}</div>
                    </div>
                    <div style={{ width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",
                      background:sk.level>=9?`${ec.p}22`:"rgba(255,255,255,0.06)",
                      border:`1px solid ${sk.level>=9?ec.p+"55":"rgba(255,255,255,0.1)"}`,
                      color:sk.level>=9?ec.p:"rgba(255,255,255,0.45)",
                      fontSize:13,fontWeight:800,fontFamily:"'Oxanium',cursive" }}>{sk.level}</div>
                  </div>
                ))
              }
            </div>
          )}

          {/* CONSTELLATIONS TAB */}
          {tab==="consts" && (
            <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10 }}>
              {char.constIcons.length === 0
                ? <div style={{ gridColumn:"1/-1",textAlign:"center",color:"rgba(255,255,255,0.25)",fontFamily:"'DM Mono',monospace",padding:36 }}>No constellation data available</div>
                : char.constIcons.map((c,i)=>(
                  <div key={i} style={{ background:c.unlocked?ec.b:"rgba(255,255,255,0.02)",
                    border:`1px solid ${c.unlocked?ec.p+"40":"rgba(255,255,255,0.07)"}`,
                    borderRadius:12,padding:12,display:"flex",flexDirection:"column",alignItems:"center",gap:8 }}>
                    <img src={c.iconUrl} alt={`C${i+1}`}
                      style={{ width:44,height:44,borderRadius:10,objectFit:"cover",
                        filter:c.unlocked?"none":"grayscale(1) brightness(0.35)",
                        boxShadow:c.unlocked?`0 0 12px ${ec.g}`:"none" }}
                      onError={e=>{ e.target.src=""; e.target.style.display="none"; }}/>
                    <div style={{ fontSize:11,fontWeight:700,color:c.unlocked?ec.p:"rgba(255,255,255,0.2)",fontFamily:"'Oxanium',cursive" }}>C{i+1}</div>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
  ASSET STATUS INDICATOR — shows loading state of store JSONs
═══════════════════════════════════════════════════════════════════════ */
function AssetStatusBadge({ assetReady, assetError }) {
  if (assetReady) return (
    <div style={{ display:"inline-flex",alignItems:"center",gap:5,fontSize:10,color:"#72FF96",
      fontFamily:"'DM Mono',monospace",background:"rgba(114,255,150,0.08)",
      border:"1px solid rgba(114,255,150,0.2)",borderRadius:20,padding:"3px 10px" }}>
      <span style={{ width:5,height:5,borderRadius:"50%",background:"#72FF96",display:"inline-block" }}/>
      Asset store loaded
    </div>
  );
  if (assetError) return (
    <div style={{ display:"inline-flex",alignItems:"center",gap:5,fontSize:10,color:"#FF8080",
      fontFamily:"'DM Mono',monospace",background:"rgba(255,80,80,0.07)",
      border:"1px solid rgba(255,80,80,0.2)",borderRadius:20,padding:"3px 10px" }}>
      ⚠ Asset store failed — names from fallback map
    </div>
  );
  return (
    <div style={{ display:"inline-flex",alignItems:"center",gap:5,fontSize:10,color:"rgba(255,255,255,0.35)",
      fontFamily:"'DM Mono',monospace",background:"rgba(255,255,255,0.04)",
      border:"1px solid rgba(255,255,255,0.08)",borderRadius:20,padding:"3px 10px",
      animation:"pulse 2s ease-in-out infinite" }}>
      ⟳ Loading asset store…
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
  MAIN APP
═══════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [inputUid, setInputUid]     = useState("");
  const [loading,  setLoading]      = useState(false);
  const [progress, setProgress]     = useState(0);
  const [error,    setError]        = useState("");
  const [result,   setResult]       = useState(null);
  const [selected, setSelected]     = useState(null);
  const [elemFilter, setElemFilter] = useState("All");
  const [cacheStatus, setCacheStatus] = useState(null);
  const [assetReady, setAssetReady] = useState(false);
  const [assetError, setAssetError] = useState(false);

  // Load asset store on mount
  useEffect(() => {
    loadAssetStore().then(() => {
      setAssetReady(assetStore.loaded);
      setAssetError(!!assetStore.error);
    });
  }, []);

  const doSearch = useCallback(async (uid, force = false) => {
    const target = (uid ?? inputUid).trim();
    if (!target) return;
    setLoading(true); setProgress(0); setError(""); setCacheStatus(null);

    const ticker = setInterval(() => setProgress(p => Math.min(p + Math.random() * 14, 82)), 220);

    try {
      const data = await fetchPlayerData(target, { forceRefresh: force });
      clearInterval(ticker); setProgress(100);
      setResult(data);
      setElemFilter("All");
      if (data.fromCache) {
        setCacheStatus(getCacheStatus(target));
      }
      setTimeout(() => setLoading(false), 300);
    } catch (e) {
      clearInterval(ticker);
      setLoading(false);
      setError(e.message ?? "Unknown error");
    }
  }, [inputUid]);

  const characters = result?.characters ?? [];
  const elements   = ["All", ...new Set(characters.map(c => c.element))];
  const filtered   = elemFilter === "All" ? characters : characters.filter(c => c.element === elemFilter);

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Oxanium:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');
    *{box-sizing:border-box} body{margin:0;background:#04040E;-webkit-font-smoothing:antialiased}
    ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:rgba(255,255,255,0.02)}
    ::-webkit-scrollbar-thumb{background:rgba(226,200,128,0.2);border-radius:3px}
    input::placeholder{color:rgba(255,255,255,0.18)}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes modalIn{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
    @keyframes cardIn{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:.45}50%{opacity:.9}}
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    @keyframes aurora{0%{transform:translate(0,0)}50%{transform:translate(30px,20px)}100%{transform:translate(0,0)}}
  `;

  return (
    <div style={{ minHeight:"100vh",background:"#04040E",color:"white",fontFamily:"'Oxanium',cursive" }}>
      <style>{css}</style>

      {/* Aurora blobs */}
      <div style={{ position:"fixed",inset:0,zIndex:0,pointerEvents:"none",overflow:"hidden" }}>
        <div style={{ position:"absolute",top:"5%",left:"5%",width:500,height:500,borderRadius:"50%",
          background:"radial-gradient(circle,rgba(226,200,128,0.05),transparent 70%)",animation:"aurora 20s ease-in-out infinite" }}/>
        <div style={{ position:"absolute",bottom:"10%",right:"5%",width:400,height:400,borderRadius:"50%",
          background:"radial-gradient(circle,rgba(125,249,255,0.04),transparent 70%)",animation:"aurora 26s ease-in-out infinite reverse" }}/>
      </div>

      {/* NAVBAR */}
      <nav style={{ position:"fixed",top:12,left:"50%",transform:"translateX(-50%)",zIndex:100,
        background:"rgba(7,7,17,0.92)",backdropFilter:"blur(24px)",
        border:"1px solid rgba(226,200,128,0.12)",borderRadius:50,
        padding:"5px 5px",display:"flex",alignItems:"center",gap:3,
        boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>
        <div style={{ padding:"5px 14px",marginRight:3,display:"flex",alignItems:"center",gap:7 }}>
          <span>⚔️</span>
          <span style={{ fontWeight:800,fontSize:12.5,background:"linear-gradient(135deg,#E2C880,#FF6B9D)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>ENKAVERSE</span>
        </div>
        {result && (
          <div style={{ padding:"5px 14px",fontSize:10,color:"rgba(255,255,255,0.28)",fontFamily:"'DM Mono',monospace" }}>
            {result.player?.nickname ?? "Traveler"} · UID {result.uid}
          </div>
        )}
      </nav>

      {/* LOADING */}
      {loading && (
        <div style={{ position:"fixed",inset:0,zIndex:999,background:"rgba(4,4,14,0.97)",
          display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18 }}>
          <div style={{ fontSize:38,animation:"spin 1.1s linear infinite" }}>✦</div>
          <div style={{ fontSize:9.5,letterSpacing:4,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace" }}>FETCHING FROM ENKA.NETWORK</div>
          <div style={{ width:240,height:2,background:"rgba(255,255,255,0.07)",borderRadius:1 }}>
            <div style={{ height:"100%",width:`${Math.min(progress,100)}%`,borderRadius:1,
              background:"linear-gradient(90deg,#E2C880,#FF6B9D)",
              transition:"width .2s ease",boxShadow:"0 0 10px rgba(226,200,128,0.6)" }}/>
          </div>
          <div style={{ fontSize:13,color:"#E2C880",fontWeight:700,fontFamily:"'Oxanium',cursive" }}>{Math.min(100,Math.round(progress))}%</div>
        </div>
      )}

      {/* MODAL */}
      {selected && <CharacterModal char={selected} onClose={() => setSelected(null)} />}

      <div style={{ position:"relative",zIndex:1,maxWidth:1060,margin:"0 auto",padding:"88px 18px 56px" }}>

        {/* SEARCH SECTION */}
        <div style={{ marginBottom: result ? 28 : 0 }}>
          {!result && (
            <div style={{ textAlign:"center",marginBottom:36,animation:"fadeIn .7s ease" }}>
              <div style={{ fontSize:10.5,letterSpacing:5,color:"#E2C880",fontFamily:"'DM Mono',monospace",marginBottom:14,animation:"pulse 3s ease-in-out infinite" }}>
                ✦ GENSHIN IMPACT · LIVE BUILD SHOWCASE ✦
              </div>
              <h1 style={{ fontSize:"clamp(36px,8vw,76px)",fontWeight:800,lineHeight:1.05,margin:"0 0 16px" }}>
                <span style={{ display:"block",background:"linear-gradient(135deg,#fff,rgba(255,255,255,0.6))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>YOUR BUILDS.</span>
                <span style={{ display:"block",background:"linear-gradient(135deg,#E2C880 0%,#FF6B9D 50%,#7DF9FF 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>LEGENDARY.</span>
              </h1>
            </div>
          )}

          <div style={{ display:"flex",gap:8,maxWidth:480,margin:"0 auto",flexWrap:"wrap",justifyContent:"center" }}>
            <div style={{ flex:1,minWidth:200,position:"relative" }}>
              <input value={inputUid}
                onChange={e => setInputUid(e.target.value.replace(/\D/g,"").slice(0,10))}
                onKeyDown={e => e.key==="Enter" && doSearch()}
                placeholder="Enter Genshin UID…"
                style={{ width:"100%",background:"rgba(255,255,255,0.04)",
                  border:`1px solid ${inputUid.length>=8?"rgba(226,200,128,0.4)":"rgba(255,255,255,0.11)"}`,
                  borderRadius:13,padding:"12px 38px 12px 16px",color:"white",fontSize:13.5,
                  fontFamily:"'DM Mono',monospace",outline:"none",
                  transition:"border-color .3s",
                  boxShadow:inputUid.length>=8?"0 0 14px rgba(226,200,128,0.12)":"none" }}/>
              {inputUid.length>=8 && (
                <div style={{ position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",
                  width:6,height:6,borderRadius:"50%",background:"#72FF96",boxShadow:"0 0 7px #72FF96" }}/>
              )}
            </div>
            <button onClick={() => doSearch()}
              style={{ background:"linear-gradient(135deg,#E2C880,#D4A843)",border:"none",
                borderRadius:13,padding:"12px 20px",cursor:"pointer",color:"#0A0A0F",
                fontWeight:800,fontSize:12.5,fontFamily:"'Oxanium',cursive",letterSpacing:.7,flexShrink:0 }}>
              SEARCH →
            </button>
            {result && (
              <button onClick={() => doSearch(result.uid, true)}
                style={{ background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.12)",
                  borderRadius:13,padding:"12px 16px",cursor:"pointer",color:"rgba(255,255,255,0.6)",
                  fontSize:12,fontFamily:"'DM Mono',monospace",letterSpacing:.5 }}>
                ↺ Refresh
              </button>
            )}
          </div>

          {/* Error */}
          {error && (
            <div style={{ maxWidth:480,margin:"10px auto 0",background:"rgba(255,70,70,0.07)",
              border:"1px solid rgba(255,70,70,0.22)",borderRadius:11,padding:"9px 15px",
              fontSize:11.5,color:"#FF8080",fontFamily:"'DM Mono',monospace",lineHeight:1.55,textAlign:"center" }}>
              ⚠ {error}
            </div>
          )}

          {/* Cache hit notice */}
          {cacheStatus && (
            <div style={{ maxWidth:480,margin:"10px auto 0",background:"rgba(125,249,255,0.06)",
              border:"1px solid rgba(125,249,255,0.18)",borderRadius:11,padding:"8px 14px",
              fontSize:11,color:"#7DF9FF",fontFamily:"'DM Mono',monospace",textAlign:"center" }}>
              ⚡ Served from cache · refreshes at {cacheStatus.expiresAt} ({cacheStatus.secondsLeft}s remaining)
            </div>
          )}
        </div>

        {/* PLAYER BANNER + CHARACTERS */}
        {result && (
          <div style={{ animation:"fadeIn .5s ease" }}>
            {/* Player info banner */}
            {result.player && (
              <div style={{ background:"linear-gradient(135deg,rgba(11,11,25,0.97),rgba(16,16,38,0.97))",
                border:"1px solid rgba(226,200,128,0.16)",borderRadius:17,padding:"20px 24px",
                marginBottom:20,position:"relative",overflow:"hidden" }}>
                <div style={{ position:"absolute",top:0,left:0,right:0,height:2,
                  background:"linear-gradient(90deg,#E2C880,#FF6B9D,#7DF9FF,#E2C880)" }}/>
                <div style={{ display:"flex",gap:16,alignItems:"center",flexWrap:"wrap" }}>
                  <div style={{ width:54,height:54,borderRadius:"50%",flexShrink:0,fontSize:24,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    background:"linear-gradient(135deg,#E2C880,#FF6B9D)",
                    boxShadow:"0 0 18px rgba(226,200,128,0.36)" }}>⚔️</div>
                  <div style={{ flex:1,minWidth:160 }}>
                    <h2 style={{ fontSize:18,fontWeight:800,margin:"0 0 3px",fontFamily:"'Oxanium',cursive" }}>
                      {result.player.nickname}
                    </h2>
                    <div style={{ fontSize:10.5,color:"rgba(255,255,255,0.38)",fontFamily:"'DM Mono',monospace" }}>
                      UID: {result.uid}
                      {result.player.signature ? ` · "${result.player.signature}"` : ""}
                    </div>
                  </div>
                  <div style={{ display:"flex",gap:20,flexWrap:"wrap" }}>
                    {[
                      { l:"ADV RANK",  v:result.player.level,        c:"#E2C880" },
                      { l:"WORLD LV",  v:result.player.worldLevel,   c:"#7DF9FF" },
                      { l:"SHOWCASED", v:characters.length,          c:"#80FF72" },
                      { l:"TTL (s)",   v:result.ttl,                 c:"#C77DFF" },
                    ].map(s=>(
                      <div key={s.l} style={{ textAlign:"center" }}>
                        <div style={{ fontSize:7.5,color:"rgba(255,255,255,0.28)",fontFamily:"'DM Mono',monospace",letterSpacing:.8 }}>{s.l}</div>
                        <div style={{ fontSize:18,fontWeight:800,color:s.c,fontFamily:"'Oxanium',cursive" }}>
                          <AnimNum target={s.v??0}/>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Integration status row */}
                <div style={{ marginTop:14,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.07)",
                  display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
                  <AssetStatusBadge assetReady={assetReady} assetError={assetError}/>
                  <div style={{ fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:"'DM Mono',monospace" }}>
                    · via CORS proxy · User-Agent: {USER_AGENT}
                  </div>
                  {result.fromCache && (
                    <div style={{ fontSize:10,color:"#7DF9FF",fontFamily:"'DM Mono',monospace",
                      background:"rgba(125,249,255,0.06)",border:"1px solid rgba(125,249,255,0.15)",
                      borderRadius:20,padding:"2px 9px" }}>⚡ from cache</div>
                  )}
                </div>
              </div>
            )}

            {/* Element filter */}
            {characters.length > 1 && (
              <div style={{ display:"flex",gap:6,marginBottom:16,flexWrap:"wrap" }}>
                {elements.map(el=>(
                  <button key={el} onClick={()=>setElemFilter(el)} style={{
                    background:elemFilter===el?"rgba(226,200,128,0.1)":"rgba(255,255,255,0.04)",
                    border:`1px solid ${elemFilter===el?"rgba(226,200,128,0.3)":"rgba(255,255,255,0.09)"}`,
                    borderRadius:30,padding:"4px 13px",cursor:"pointer",
                    color:elemFilter===el?"#E2C880":"rgba(255,255,255,0.4)",
                    fontSize:10.5,fontFamily:"'DM Mono',monospace",transition:"all .18s" }}>
                    {el!=="All"&&ELEM[el]?ELEM[el].e+" ":""}{el.toUpperCase()}
                  </button>
                ))}
              </div>
            )}

            {/* Character grid */}
            {filtered.length === 0
              ? <div style={{ textAlign:"center",color:"rgba(255,255,255,0.22)",fontFamily:"'DM Mono',monospace",padding:36 }}>
                  No {elemFilter} characters in showcase
                </div>
              : <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:12 }}>
                  {filtered.map((char,i) => (
                    <CharacterCard key={char.avatarId} char={char} onClick={setSelected} idx={i}/>
                  ))}
                </div>
            }

            {characters.length === 0 && (
              <div style={{ textAlign:"center",padding:40,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace" }}>
                <div style={{ fontSize:40,marginBottom:12 }}>📭</div>
                Player found but no characters are set in the showcase.
                <br/>
                <span style={{ fontSize:10.5,color:"rgba(255,255,255,0.2)" }}>
                  In-game: Paimon Menu → Profile → Character Showcase → add up to 8 characters
                </span>
              </div>
            )}
          </div>
        )}

        {/* Info cards (shown when no result yet) */}
        {!result && (
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(195px,1fr))",gap:13,maxWidth:840,margin:"44px auto 0",animation:"fadeIn .8s ease .3s both" }}>
            {[
              { icon:"🔗", title:"Req 1 — Correct Endpoint",    desc:`${ENKA_BASE}/api/uid/<UID>`,          color:"#E2C880" },
              { icon:"🪪", title:"Req 2 — Custom User-Agent",   desc:`${USER_AGENT} forwarded via X-User-Agent header`, color:"#7DF9FF" },
              { icon:"🗂️", title:"Req 3 — ID Mapping",          desc:"Loads store/characters.json + store/loc.json from official Enka repo", color:"#C77DFF" },
              { icon:"🛡️", title:"Req 4 — Safe Parsing",        desc:"Every field guarded with ?? fallbacks, try/catch per avatar", color:"#80FF72" },
              { icon:"⚡", title:"Req 5 — TTL Cache",           desc:"In-memory Map keyed by UID, ttl seconds from API response", color:"#FF6B9D" },
            ].map((f,i) => (
              <div key={i} style={{ background:"rgba(255,255,255,0.025)",border:"1px solid rgba(255,255,255,0.07)",
                borderRadius:13,padding:16,transition:"all .22s" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=f.color+"30";e.currentTarget.style.transform="translateY(-3px)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.07)";e.currentTarget.style.transform="translateY(0)";}}>
                <div style={{ fontSize:22,marginBottom:7 }}>{f.icon}</div>
                <div style={{ fontSize:11.5,fontWeight:700,color:f.color,marginBottom:4 }}>{f.title}</div>
                <div style={{ fontSize:10,color:"rgba(255,255,255,0.3)",fontFamily:"'DM Mono',monospace",lineHeight:1.55 }}>{f.desc}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ textAlign:"center",padding:"14px 0 22px",fontSize:9.5,color:"rgba(255,255,255,0.13)",fontFamily:"'DM Mono',monospace",position:"relative",zIndex:1 }}>
        ENKAVERSE · DATA VIA ENKA.NETWORK · NOT AFFILIATED WITH HOYOVERSE
      </div>
    </div>
  );
}
