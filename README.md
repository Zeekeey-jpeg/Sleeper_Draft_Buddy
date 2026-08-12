<!-- ============================================================= -->
<!--  DRAFT BUDDY — README                                         -->
<!--  Your coach in your ear while YOU draft. Free. No login.      -->
<!-- ============================================================= -->

<p align="center">
  <img src="docs/hero.png" alt="Draft Buddy — live draft war room for Sleeper" width="820" />
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=22&pause=1000&color=F0A832&center=true&vCenter=true&width=780&lines=Your+live+draft+war+room+for+Sleeper.;Who+to+take.+Why.+Right+now.;Paste+a+draft+link.+Ride+shotgun." alt="typing" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/100%25-free-f0a832?style=for-the-badge" />
  <img src="https://img.shields.io/badge/phone%20·%20tablet-·%20laptop-1f6feb?style=for-the-badge" />
  <img src="https://img.shields.io/badge/no%20login-nothing%20to%20install-8a5cf6?style=for-the-badge" />
  <img src="https://img.shields.io/badge/works%20with-Sleeper-16a34a?style=for-the-badge" />
</p>

---

## What is Draft Buddy?

**It's your coach in your ear while YOU draft.** You still draft in Sleeper like always — Draft
Buddy watches every pick land and tells you who to take and *why*, right now, for your seat.

It will never make a pick for you. That part's still on you, champ.

---

## 🚀 Get in here

<p align="center">
  <a href="https://zeekeey-jpeg.github.io/Sleeper_Draft_Buddy/">
    <img src="https://img.shields.io/badge/▶%20OPEN%20DRAFT%20BUDDY-Tap%20here%20to%20start-f0a832?style=for-the-badge&labelColor=10151c" alt="Open Draft Buddy" height="46" />
  </a>
</p>

<p align="center">
  Works on your <b>phone, iPad, or laptop</b> — it checks your screen and hands you the right
  version. Phone gets the mobile war room, iPad and laptop get the full cockpit.
</p>

### 📲 Put it on your phone like an app

1. Open the link above on your phone.
2. Hit the **Share** button (iPhone) or the **⋮ menu** (Android).
3. Tap **Add to Home Screen**.

Now it's an icon next to your other apps. No app store, no account.

### 💻 Want it on your desktop?

Grab the zip from **[Releases](https://github.com/Zeekeey-jpeg/Sleeper_Draft_Buddy/releases/latest)**,
unzip it, and double-click `run.cmd` (Windows) or `run.sh` (Mac) — it opens right up.

### Then:

1. **Paste your Sleeper draft link** — or just type your Sleeper username and it finds your drafts for you.
2. **Tap your seat.** Your league's team names are already filled in.
3. That's it. Go draft.

> 🚨 **One gotcha:** mocks you start inside the Sleeper *phone app's* lobby are invisible to
> everything outside Sleeper — nothing to paste. Start mocks at **sleeper.com** in a browser
> instead. Real league drafts work fine either way.

---

## 🏈 What it does

- **📡 Every pick, live.** The board updates the second someone picks. No refreshing.
- **🎯 Who to take — and why.** Not just a name. "Last stud RB before the drop-off." "3 QBs
  just went." In actual English.
- **⏳ "Will he come back to me?"** A straight-up percentage on whether your guy survives to
  your next pick. This is the fun one.
- **🔥 Run alerts.** When the room starts panic-drafting a position, you get told *while it's
  happening*, not after.
- **🧾 Your roster + bye weeks.** See your lineup filling in, and get warned when week 11 would
  leave you starting nobody.
- **⭐ Star your guys. 🚫 Ban the ones who burned you.** Both stick around next time.
- **🏆 Superflex, 2QB, keepers — all handled.** It reads your league's real settings.
- **🔒 No login, no install, no tracking.** Nothing to sign up for. Nothing leaves your phone.

<p align="center"><sub>
Draft Buddy suggests — it never makes a pick for you. Every Sleeper call is read-only.
</sub></p>

---

<details>
<summary><b>🧠 For the nerds: how the engine actually thinks</b></summary>

<br/>

No black box. Here's the whole chain, in order:

**1. Projections, scored under *your* league's rules.**
Season projections get re-scored using the league's actual scoring settings — every scoring key
that matches a projected stat contributes. A TE-premium league and a standard league produce
different numbers from the same player. Injury designations discount season-long value (an
"Out" costs real weeks; a preseason "Questionable" is noise).

**2. VORP — value over replacement.**
Raw points don't tell you anything. What matters is the gap between a player and the guy you'd
be starting instead. So the engine works out how many players at each position actually get
started league-wide (counting flex and superflex realistically), finds the replacement-level
player at each position, and measures everyone against *that*.

**3. A market blend against superflex ADP.**
Pure season-total VORP undervalues quarterbacks in 2QB leagues — you can't stream a QB when
everyone needs two, so the market prices that scarcity harder than season points imply. The
engine blends its own valuation with where the market actually drafts, which keeps it honest
in both directions: it still catches value falling past its ADP, but it doesn't hand you a
board that no real room would ever produce.

**4. Tiers, by where the cliffs are.**
Positions get cut into tiers at the real gaps in projected points, not at round numbers. This
is what turns "take the best player" into "take *him*, because he's the last one before the
drop-off."

**5. Survival probability to your next pick.**
The headline number. For each candidate, the engine walks every single pick between now and
your next turn and asks: does *this* team, with *this* roster, plausibly take him? Teams with
two quarterbacks already stop threatening quarterbacks. Keeper-occupied slots don't threaten
anyone. The whole model is recalibrated live against how this specific room is drafting, which
is what makes it work in keeper leagues where everyone goes earlier than redraft ADP says.

**6. Run pressure and supply deadlines.**
Over a rolling window, the engine compares how many players at each position *actually* went
against how many *should* have gone. A genuine burst reads as a run and pulls everyone's
expected pick earlier. Separately it estimates when each position's startable supply runs dry —
and if that happens before your next couple of turns while you still need a starter there,
this window gets flagged as urgent.

**7. The recommendation.**
Value now, minus what you can realistically expect to still be there later, weighted by your
actual roster needs, positional scarcity, deadline pressure, and bye-week coverage. The winner
becomes **THE PICK**; the runners-up become **PATH B** and **PATH C**, each with its own
argument and a preview of what your following pick likely looks like.

It's deterministic: the same room state always produces the same advice. No dice, no vibes.

<br/>

### A few common questions

**Is this allowed?**
Yes. Draft Buddy only *reads* from Sleeper's public API — the same endpoints that power public
draft boards. It never makes a pick, never automates anything, and never writes a single byte
back. Every selection is still yours, entered by you, in Sleeper. It's a second screen, not a bot.

**Does it see my Sleeper account?**
No. There's no login, no password field, no token. It reads public draft data and that's all.
Your watchlist, your banned players, and your settings live on your own device. There's no
backend to send anything to, and no analytics of any kind.

**What league types work?**
Snake drafts, including third-round-reversal. Redraft and **keeper** leagues (keepers load onto
the board and the engine accounts for the picks they consume). **Superflex / 2QB is fully
supported** — roster math, ADP, and replacement levels all understand it. Auction drafts are not
supported.

**What if it closes mid-draft?**
Reopen it, re-attach, confirm your seat. The entire pick history reloads in one shot and you're
right back where the room is. Takes about fifteen seconds.

**Under the hood:** one HTML file and plain JavaScript. No frameworks, no dependencies, no build
step. Read all of it if you want — it's MIT licensed.

</details>

---

## 💸 Donations

<p align="center">
  <b>Draft Buddy is free. Forever. No ads, no upsell, no "pro" tier.</b><br/>
  If you find it useful, any donation is appreciated — it keeps the upgrades coming.
</p>

<p align="center">
  <a href="https://venmo.com/Brian-Scott-2">
    <img src="https://img.shields.io/badge/💸%20Donate-Venmo%20@Brian--Scott--2-008CFF?style=for-the-badge&logo=venmo&logoColor=white" alt="Donate on Venmo" />
  </a>
  <a href="https://www.paypal.me/brianscott31">
    <img src="https://img.shields.io/badge/💳%20No%20Venmo%3F-Card%20or%20PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="Donate by card or PayPal" />
  </a>
</p>

<table align="center"><tr>
  <td align="center"><img src="assets/venmo-qr.jpg" alt="Venmo QR — @Brian-Scott-2" width="220" /><br/><sub>Venmo — scan with your phone</sub></td>
  <td align="center"><img src="assets/paypal-qr.jpg" alt="PayPal QR — paypal.me/brianscott31" width="220" /><br/><sub>Card or PayPal — no account needed</sub></td>
</tr></table>

<p align="center">
  <sub>Or just hit the 🎁 button in the app — $1 / $5 / $10 / $20, one tap, no sign-up.</sub>
</p>

<p align="center">
  <sub>Not into donating? A ⭐ Star helps other people find it, and that works too.</sub>
</p>

---

<p align="center"><sub>
MIT licensed · Not affiliated with, endorsed by, or connected to Sleeper · Built by
<a href="https://www.helpmebim.com">HelpMeBIM</a>
</sub></p>
