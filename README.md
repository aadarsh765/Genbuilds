# ✦ EnkaVerse

> A cinematic Genshin Impact character showcase — powered by the [Enka.Network](https://enka.network) API.

![EnkaVerse Preview] https://aadarsh765.github.io/Genbuilds/

---

## 🌟 Features

- 🔍 **Live profile lookup** by UID — fetches your in-game showcase characters
- 🃏 **Character cards** with side art, stats, constellations, and CRIT Value score
- ✨ **Cinematic UI** — dark glassmorphism, particle background, 3D card tilt on hover
- 🎨 **Element-aware theming** — card banners tinted by element color
- ⚡ **TTL caching** — avoids repeated API calls (60s window)
- 🌐 **CORS proxy chaining** — falls back across multiple proxies automatically

---

## 🚀 Usage

1. Open `index.html` in any modern browser (no build step needed!)
2. Enter your Genshin Impact UID (9–10 digits)
3. Press **SEARCH** or hit `Enter`

> Make sure you have characters **set on your in-game showcase** (Profile → Edit → Character Showcase)

---

## 🛠 Tech Stack

| Layer | Tech |
|-------|------|
| UI | Vanilla HTML/CSS/JS (zero dependencies) |
| Fonts | [Oxanium](https://fonts.google.com/specimen/Oxanium) + [DM Mono](https://fonts.google.com/specimen/DM+Mono) |
| Data | [Enka.Network API](https://github.com/EnkaNetwork/API-docs) |
| Metadata | `store/characters.json` + `store/loc.json` (EnkaNetwork GitHub) |
| CORS | allorigins.win → corsproxy.io → codetabs.com (chain fallback) |

---

## 📡 API Details

```
GET https://enka.network/api/uid/{UID}
```

| Field | Description |
|-------|-------------|
| `playerInfo` | Nickname, AR level, world level, abyss progress |
| `avatarInfoList` | Characters on showcase |
| `fightPropMap` | Numeric-key stat map (HP, ATK, DEF, CRIT, ER, EM…) |
| `propMap["4001"]` | Character level |
| `talentIdList` | Unlocked constellation IDs |

**Key fight prop IDs:**

| Key | Stat |
|-----|------|
| `2000` | HP (total) |
| `2001` | ATK (total) |
| `2002` | DEF (total) |
| `20` | CRIT Rate |
| `22` | CRIT DMG |
| `23` | Energy Recharge |
| `28` | Elemental Mastery |

**CRIT Value formula:**
```
CV = (CRIT Rate × 100 × 2) + (CRIT DMG × 100)
```

---

## 📁 Project Structure

```
EnkaVerse/
└── index.html   # Single-file app (HTML + CSS + JS)
```

---

## ⚠ Disclaimer

EnkaVerse is a fan-made project and is **not affiliated with HoYoverse**.  
Genshin Impact™ is a trademark of HoYoverse Co., Ltd.  
Character assets belong to their respective owners.

---

## 🙏 Credits

- [Enka.Network](https://enka.network) — the API and CDN powering this app
- [EnkaNetwork/API-docs](https://github.com/EnkaNetwork/API-docs) — official docs and data files
