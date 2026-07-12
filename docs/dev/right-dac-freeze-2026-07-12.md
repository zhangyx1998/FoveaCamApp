# Right-fovea DAC freeze — diagnosis (2026-07-12)

Recurring field issue reported by Yuxuan: the RIGHT fovea's DAC module randomly
stops responding and the mirror freezes at its current location. Survives
across PCB swaps, firmware versions, protocol versions, and applications.
Exiting and re-entering the app recovers it for another few minutes.

Status: **MITIGATIONS M1–M3 SHIPPED** (2026-07-12, two-worker wave — see AS
SHIPPED below). Root-cause confirmation is rig-gated: run the discriminating
bench procedure (mirrored in `docs/hardware/stage-f.md` → "MEMS DAC recovery").

## What the symptom fingerprint tells us

Everything the user varied (boards, firmware/protocol versions, apps) shares
the same constants:

- the `MEMS.cpp` SPI driver lineage (init-once, no reassertion, no recovery);
- the shared-bus topology: one 10 MHz SPI bus (SCLK 13 / MOSI 11), two
  AD5664R quad DACs framed by separate chip-selects (`Board::mems_cs[]`,
  pin 9 = left, pin 10 = right);
- the physical wiring geometry of the right driver board;
- the recovery path: `SET System::Enable(false → true)` is the ONLY thing an
  app restart does that a running session never does, and it does two things
  at once (Protocol.cpp:168):
  1. power-cycles the driver rail (`Board::enable`, pin 15);
  2. `MEMS::enable()` → **AD5664R full software RESET (0x280001)** + internal
     reference on + all-channel DAC power ON + LDAC setup + neutral bias.

So the wedge lives in state that a DAC reset / rail cycle clears — i.e. in the
right AD5664R (or its HV driver), not in host or stream logic.

Supporting exclusion: `Streams::tick()` (Streams.cpp:103) writes LEFT and
RIGHT back-to-back from the same table entry every dirty tick. Any host-side,
protocol, or stream-state failure freezes BOTH eyes. Left continuing while
right freezes places the fault strictly below `MEMS::set(RIGHT)`: the CS2
line, the right DAC, or the right driver stage. No ISR touches SPI (the
strobe ISR only snapshots RAM), so firmware-side transaction interleaving is
ruled out by construction.

## Ranked hypotheses

### H1 (primary): corrupted SPI word latches the right DAC into power-down

A single glitched SCLK edge (reflection/crosstalk on the shared 10 MHz bus
run to the driver boards) makes one 24-bit frame execute with shifted bits —
i.e. a random command. 1 in 8 random commands is `DAC_POWER` (0b100); any
PD1/PD0 ≠ 00 in the payload **disconnects the output stage** (1 kΩ / 100 kΩ /
tri-state). The amp input then holds via its input impedance → mirror frozen
in place. Subsequent `WRITE_UPDATE_DAC` words still load registers, but the
output stays disconnected — the DAC looks deaf. Nothing in a running session
ever re-sends `DAC_POWER` or `RESET`, so the wedge is permanent until the app
restarts (which sends both).

Fits every observation:
- frozen-in-place (not snapped to neutral/rail);
- deaf to further updates, healed by re-init;
- random with a minutes timescale: at a 600 Hz stream, tick() pushes 9 words
  ≈ 5.4 k words/s ≈ 2 M words per ~6 min — a word-error rate around 5e-7
  produces exactly "every few minutes";
- right-only: same bus, but the right driver sits at a different (presumably
  farther/noisier) point of the cable run — an SI asymmetry that reproduces
  across board swaps because the design/geometry is the same;
- survives firmware/protocol/app versions: the vulnerable init-once model is
  common to all of them.

Corollary prediction: most corrupted words are benign mis-addressed value
writes → occasional single-sample twitches on random channels, which may have
been previously binned as generic flicker. Left should also freeze, rarely.

### H2: right HV driver latch-up

Recovered by the pin-15 rail cycle rather than the DAC reset. Weaker fit:
driver faults typically collapse the output (mirror snaps to neutral/rail)
rather than hold position. Kept because Enable(true) confounds the two
recoveries — the bench procedure below separates them.

### H3: host-side right-eye pipeline wedge — effectively excluded

Both eyes ride in every UPDATE packet and both are written per tick; the
issue is cross-app and predates recent host changes. One bench command
falsifies it conclusively (step 1 below).

## Discriminating bench procedure (stage-f)

When the freeze occurs, in order, WITHOUT restarting the app:

1. Send `CMD_ACTUATE` with a new right position. Moves → H3 after all
   (host-side); stop and re-investigate host.
2. Send a MEMS re-init alone (no rail toggle) — needs the M2 debug command
   below, or a temporary bench firmware hooking re-init to an existing SET.
   Recovers → **H1 confirmed** (DAC latched state).
3. Toggle `Board::enable` alone. Recovers only here → H2 (driver latch-up).
4. Scope SCLK + SYNC2 at the right driver's connector vs the left's: ringing,
   monotonicity, ground offset at 10 MHz.

## Proposed mitigation wave (software; pending ruling)

- **M1 — periodic config re-assertion (~1 Hz), both devices:** re-send
  `DAC_POWER 0b1111` + `INT_REF_SETUP 1` + `LDAC_SETUP 0` (idempotent, output
  value untouched — NEVER `RESET`, which zeroes outputs), then mark the
  active stream dirty so targets re-commit. Converts a permanent wedge into a
  ≤1 s glitch. Doubles as a live H1 test: if freezes stop recurring under
  M1, H1 is confirmed by elimination. Cost: 6 words/s on a bus running 5.4 k.
- **M2 — targeted recovery command:** extend `SET System::Reset` with a
  `MEMS` type (Protocol.cpp:136 currently HARD/SOFT) that calls
  `MEMS::enable()` re-init WITHOUT touching the rail or stream table — the
  bench discriminator for step 2, and an app-side "recover mirror" button
  that doesn't drop the session.
- **M3 — SPI clock knob:** drop `SPISettings` from 10 MHz to 2 MHz (settings
  in MEMS.cpp:14). Timing budget is trivial: 9 words/tick ≈ 145 µs at 2 MHz
  vs a 1.67 ms tick. Fewer marginal edges at the far end of the bus. Could be
  a build-time constant first, config knob later.
- **M4 — hardware note (rig):** series termination at the Teensy on SCLK/MOSI,
  verify the right cable's length/return path. Out of software scope; log
  findings from procedure step 4 here.

Detection caveat: the AD5664R is write-only (no readback), so the wedge
cannot be detected in firmware — only prevented (M1/M3) or recovered
(M1/M2). Host-side detection would have to infer from camera feedback
(commanded delta produces no image motion), which is app-layer and not
proposed here.

## AS SHIPPED (2026-07-12)

M1–M3 landed as **protocol v2.1.0** (`lib/Protocol/Version.h`; backward
compatible — wire layout unchanged, old firmware REJects the unknown reset
type). M4 remains a rig item (procedure step 4 feeds it).

- **M1** — `MEMS::refresh()` (MEMS.cpp): DAC_POWER 0x20000F + INT_REF
  0x380001 + LDAC 0x300000 to both mirrors, no RESET / no value write.
  Cadenced by `Streams::housekeeping()` at ~1 Hz off `Global::time`, only
  while enabled, primed on the enable edge; each refresh `touch()`es the
  active stream so `tick()` re-commits live targets. Called from `loop()`
  (Firmware.cpp) and the fw-sim loop.
- **M2** — `Reset::Type::MEMS = 2` (Packet.h) + firmware branch
  (Protocol.cpp `HANDLE_SET(System::Reset)`): full `MEMS::enable()` re-init
  (intentionally incl. RESET) with NO rail cycle and NO stream-table clear,
  then `Streams::touch()`; ACK when enabled, REJ otherwise. Host:
  `Controller.recoverMems()` (orchestrator/controller.ts) gated by
  `v21Capable` (version retained from `verifyVersion()`), exposed through
  the controller session contract to a **Recover mirror** button in the
  title-bar Controller dropdown (Controller.vue) — disabled with tooltip
  when not enabled / firmware < 2.1.0; REJ lands in the error tray.
  `convert<Reset::Type>` string mappings added in lib/Protocol/Packet.cpp
  (were missing for SOFT/HARD too — string-typed Reset would have hit an
  undefined symbol at runtime).
- **M3** — requested SPI clock 20 MHz → **2 MHz** (`SPI_CLOCK_HZ`,
  MEMS.cpp). Actual on-wire clock after the Teensy divider is RIG-GATED.
- **Tests** — core/test/49-firmware-recovery.ts (fw-sim word-level: refresh
  triple + cadence + disabled-silence; MEMS reset train + ACK/REJ +
  re-commit; version 2.1.0), 47 updated for the version bump,
  app/test/controller-recover.test.ts (enum on the wire, version boundary
  sweep, REJ propagation). Full gates green: core build, fw-sim build +
  fw-sim-check, `pio run` (teensy40), numbered tests 24/46/47/48/49,
  vue-tsc, vitest 1196/1196, vite build, check-boundaries. (Numbered tests
  12 and 36 fail identically at clean HEAD — pre-existing, unrelated: 12 =
  OpenCV KCF env on the Lab PC, 36 = `Subscriber::close()` lock-order
  deadlock, tracked separately.)
- **Docs** — docs/spec/serial-protocol.md + docs/architecture/serial-protocol.md
  (v2.1.0, MEMS reset semantics, auto-refresh), docs/manual/getting-started.md
  (button), stage-f "MEMS DAC recovery" checklist (flash v2.1.0 first).
