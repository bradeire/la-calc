# LA Dose Calculator

A mobile-optimised Progressive Web App (PWA) for calculating maximum safe doses of local anaesthetic drugs, including mixture calculations, nerve block duration estimates, additive dosing, and awake fibreoptic intubation (AFOi) topical dosing.

**Live app:** https://bradeire.github.io/la-calc

---

## Features

- **Blocks tab** — dose calculator for single drugs and mixtures using fractional max-dose logic (e.g. 40% lidocaine + 60% bupivacaine = 100% total capacity used)
- **Block selector** — 30+ nerve blocks with suggested volumes, concentrations, and predicted duration ranges
- **Additives** — expandable dose panels for adrenaline, dexamethasone, clonidine, dexmedetomidine, sodium bicarbonate, and hyaluronidase, with weight-adjusted safety checks
- **Duration projection** — dynamically calculated from the actual drugs and additives entered
- **AFOi tab** — topical lidocaine dose calculator for awake fibreoptic intubation, with per-agent bioavailability adjustment
- **Offline capable** — works without internet after first load

---

## Installing on your phone

### Android (Chrome)
1. Open https://bradeire.github.io/la-calc in Chrome
2. Tap the **⋮ menu → Add to Home Screen**
3. Tap **Install** when prompted
4. The app appears on your home screen and opens fullscreen with no browser chrome

### iPhone / iPad (Safari)
1. Open https://bradeire.github.io/la-calc in **Safari** (must be Safari, not Chrome)
2. Tap the **Share icon** (box with arrow pointing up)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**
5. The app appears on your home screen and opens fullscreen

> **Note:** After installing, the app works fully offline. When updates are pushed, the app will refresh automatically the next time you open it with an internet connection.

---

## Drug maximum doses

All doses are drawn from standard literature references. The app uses the lower of weight-based (mg/kg) and absolute caps.

| Drug | Plain | + Adrenaline | 24 h cap |
|---|---|---|---|
| Lidocaine | 3 mg/kg / 200 mg | 7 mg/kg / 500 mg | — |
| Bupivacaine | 2 mg/kg / 150 mg | 2 mg/kg / 150 mg | 400 mg |
| Levobupivacaine | 2 mg/kg / 150 mg | 2.5 mg/kg / 150 mg | 400 mg |
| Ropivacaine | 3 mg/kg / 225–300 mg* | — | 770 mg |
| Prilocaine | 6 mg/kg / 400 mg | 8 mg/kg / 600 mg | — |
| Mepivacaine | 5 mg/kg / 400 mg | 7 mg/kg / 550 mg | — |
| Cocaine (topical) | 1.5 mg/kg / 150 mg | — | — |

*Ropivacaine absolute cap toggled between 225 mg and 300 mg depending on block type.

**Topical (AFOi):** 9 mg/kg maximum per AAGBI/DAS guidance.

> **Disclaimer:** Doses are provided as a clinical reference only. Always verify against your local formulary, departmental guidelines, and current literature. This app does not replace clinical judgement.

---

## Mixture logic

Mixtures are calculated by summing the fractional maximum dose of each drug used:

```
Total fraction used = (mg given of drug A / max dose of drug A) + (mg given of drug B / max dose of drug B) + ...
```

Remaining capacity for any drug = `(1 − total fraction used) × max dose of that drug`

This means if 40% of the lidocaine maximum has been used, only 60% of any other drug's maximum dose remains available.

---

## Development

Built as a single-file HTML/CSS/JS PWA with no build tools or dependencies.

```
la-calc/
├── index.html      # Entire application
├── manifest.json   # PWA manifest
├── sw.js           # Service worker (offline caching)
├── icon-192.png    # App icon
└── icon-512.png    # App icon (large)
```

To update and deploy:
```bash
git add .
git commit -m "Description of change"
git push
```

GitHub Pages deploys automatically within ~60 seconds of each push.

---

© 2026 Ó Brolcháin · Version 1.0
