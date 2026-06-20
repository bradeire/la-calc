# LASTCalc Changelog

---

## v1.2 — Beta features merged (2026-06-20)

### New features
- **Show Workings** — tap the gauge to open a step-by-step breakdown of the fractional dose calculation, showing each drug's contribution, running total, dose weight rationale, and remaining capacity
- **Print / Export PDF** — generates a white-background clinical report with SVG half-donut gauge, per-drug table with mini bars and coloured risk indicators, block info, and patient demographics; suitable for pasting into an EPR
- **AFOi → Blocks transfer** — send the total topical lidocaine dose from the AFOi tab directly into the Blocks tab as a prior entry, using the correct 9 mg/kg topical ceiling throughout

### Bug fixes
- AFOi-transferred lidocaine now correctly measured against the 9 mg/kg topical ceiling (AAGBI/DAS) in all calculations — app gauge, Show Workings, and Print report — rather than the 3 mg/kg infiltration ceiling
- Transfer always uses the full administered dose (no bioavailability reduction) to remain conservative for LAST risk
- Print PDF no longer bleeds the dark app background into the exported page; report is fully white
- Show Workings displays the correct note ("Topical ceiling: X kg × 9 mg/kg") for AFOi entries instead of the infiltration formula

---

## v1.1 — Anthropometrics, paediatrics, prior LA (2026-05-xx)

### New features
- **Rename** — app renamed from "LA Dose Calculator" to "LASTCalc"
- **Body metrics panel** — tap the weight pill to expand height, sex, and age inputs; calculates BMI, BSA (Mosteller), IBW (Devine), LBW (Janmahasatian); automatically uses LBW as dose weight when BMI ≥ 30
- **Paediatric dosing** — age-based dose ceilings for neonates, <6 months, 6–12 months, and >1 year; paediatric banner shown when active
- **Prior LA** — add drugs administered by another clinician within the 6-hour window; included in fractional dose calculation with amber styling
- **Disclaimer modal** — shown on first launch; accessible via footer link
- **Install page** — `/install.html` with platform-aware guidance (Android `beforeinstallprompt` or iOS Safari step-by-step)
- **Gauge card enhancements** — total mg given displayed alongside percentage; TBW/LBW dose weight label shown as a pill

### Bug fixes
- Weight input no longer fights for focus with height/age inputs on panel open
- Height input no longer shows duplicate "cm" label
- Age placeholder no longer shows "—" in numeric input on mobile
- BMI/BSA calculations now trigger correctly when height is entered

---

## v1.0 — Initial release

- Fractional dose mixture calculator for lidocaine, bupivacaine, levobupivacaine, ropivacaine, prilocaine, mepivacaine
- Half-donut gauge with colour-coded risk (green / amber / red)
- Remaining capacity table with ml-per-concentration breakdown
- Nerve block selector (30+ blocks) with suggested volumes, concentrations, and predicted duration
- Additives panel: adrenaline, dexamethasone, clonidine, dexmedetomidine, sodium bicarbonate, hyaluronidase
- AFOi tab: per-agent topical lidocaine dose calculator with bioavailability adjustment and per-route breakdown
- PWA: offline capable via service worker, installable on Android and iOS
- Privacy-friendly analytics (Plausible)
