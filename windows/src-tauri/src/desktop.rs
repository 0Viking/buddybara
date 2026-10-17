// Buddybara on the desktop: his own small window, wherever the user dropped him,
// with the geometry it needs (`logic` below, with its tests).
//
// The panel page runs his life cycle (src/island/desktop.ts): out at launch, put
// away by his minimize button. This file owns the window — where it is, which
// part of it takes the mouse, the flight out, the drag, and the saved spot.
//
// How the window is placed depends on the system (platform::DesktopMode):
//   * Windows: anywhere, in physical desktop pixels. A cursor poll — running
//     only while he is awake on the desktop — makes the window click-through
//     except over his body, feeds his eyes, and carries him during a drag.
//   * Linux X11: the same coordinates; the input region is his body, and the
//     page drives the drag.
//   * Linux layer-shell: a layer surface on the panel's display, placed with
//     margins in logical pixels.
//   * GNOME on Wayland: off, nothing is created.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::island::{self, PollGate};
use crate::platform::{self, DesktopMode, MouseShape};
use crate::settings::{self, DesktopSpot};

pub const LABEL: &str = "buddybara";

/// Side of the square window, logical pixels (DesktopBuddybaraLogic.panelSize).
pub const SIZE: f64 = 120.0;
/// Kept between him and the edges of the work area (DesktopBuddybaraLogic.clampMargin).
const MARGIN: f64 = 24.0;
/// Flying out to his spot (0.45 s, ease in-out).
const FLIGHT_MS: u64 = 450;
/// Settling into his spot after a drop (0.25 s, with a little overshoot).
const SNAP_MS: u64 = 250;
const TICK_MS: u64 = 16;

/// Windows never hides his window: it parks it off-screen. tao shows a hidden
/// window again with SW_SHOW, which may take the keyboard focus from whatever
/// the user is typing in each time he flies out; a window created visible
/// (shown without activation) and only ever moved never is. Same as the
/// panel, which is never re-shown either.
const PARK: bool = cfg!(windows);
const PARKED: (f64, f64) = (-32000.0, -32000.0);

// ── Pure geometry ─────────────────────────────────────────────────────────────

pub mod logic {
    /// A rectangle, y down, in whatever space the caller works in.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Rect {
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
    }

    impl Rect {
        pub fn contains(&self, p: (f64, f64)) -> bool {
            p.0 >= self.x && p.0 < self.x + self.w && p.1 >= self.y && p.1 < self.y + self.h
        }

        pub fn center(&self) -> (f64, f64) {
            (self.x + self.w / 2.0, self.y + self.h / 2.0)
        }
    }

    /// A connected display: its whole area, the part windows may use (no
    /// taskbar), and how many of the space's units make one logical pixel.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Display {
        pub frame: Rect,
        pub work: Rect,
        pub scale: f64,
    }

    /// Radius of the clickable body, as a fraction of the window side.
    pub const BODY_RADIUS_FRACTION: f64 = 0.24;
    /// Radius that holds all of him as drawn — mikan, paws — but not the empty
    /// corners of his window: where a file dragged onto him is taken.
    pub const FIGURE_RADIUS_FRACTION: f64 = 0.42;

    /// Hit test of the round body inside the square window (window-local).
    pub fn is_over_body(local: (f64, f64), size: f64) -> bool {
        is_within(local, size, BODY_RADIUS_FRACTION)
    }

    /// His minimize button, top-right of his head (buddybara.html
    /// #hide), centre and radius in window pixels — a little over its size.
    pub const HIDE_BUTTON: (f64, f64, f64) = (94.0, 28.0, 11.0);

    pub fn is_over_hide_button(local: (f64, f64)) -> bool {
        let (cx, cy, r) = HIDE_BUTTON;
        let (dx, dy) = (local.0 - cx, local.1 - cy);
        dx * dx + dy * dy <= r * r
    }

    /// Within `fraction` of the window side from its centre (window-local).
    pub fn is_within(local: (f64, f64), size: f64, fraction: f64) -> bool {
        let c = size / 2.0;
        let r = size * fraction;
        let (dx, dy) = (local.0 - c, local.1 - c);
        dx * dx + dy * dy <= r * r
    }

    /// Keeps a window of side `size` inside `work`, `margin` from each edge.
    pub fn clamp_origin(origin: (f64, f64), size: f64, work: Rect, margin: f64) -> (f64, f64) {
        (
            origin.0.max(work.x + margin).min(work.x + work.w - size - margin),
            origin.1.max(work.y + margin).min(work.y + work.h - size - margin),
        )
    }

    /// The display whose frame holds `p`, or else the one whose centre is closest.
    pub fn display_near(p: (f64, f64), displays: &[Display]) -> Option<Display> {
        displays.iter().copied().find(|d| d.frame.contains(p)).or_else(|| {
            displays.iter().copied().min_by(|a, b| {
                let da = dist2(p, a.work.center());
                let db = dist2(p, b.work.center());
                da.total_cmp(&db)
            })
        })
    }

    fn dist2(a: (f64, f64), b: (f64, f64)) -> f64 {
        (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)
    }

    /// Where a window dropped with its top-left at `origin` settles: inside the
    /// work area of the display under its centre (or the nearest one).
    pub fn settle(origin: (f64, f64), displays: &[Display], size: f64, margin: f64) -> (f64, f64) {
        let Some(first) = displays.first() else { return origin };
        let half = size * first.scale / 2.0;
        let Some(d) = display_near((origin.0 + half, origin.1 + half), displays) else {
            return origin;
        };
        clamp_origin(origin, size * d.scale, d.work, margin * d.scale)
    }

    /// A spot saved at an earlier launch, checked against the displays
    /// connected now: `None` when none of them holds its centre any more (the
    /// monitor was unplugged) — he then stays put away. A spot that is
    /// still on a display is pulled back inside its work area.
    pub fn restore_spot(
        spot: (f64, f64),
        displays: &[Display],
        size: f64,
        margin: f64,
    ) -> Option<(f64, f64)> {
        displays.iter().find_map(|d| {
            let s = size * d.scale;
            let center = (spot.0 + s / 2.0, spot.1 + s / 2.0);
            d.frame
                .contains(center)
                .then(|| clamp_origin(spot, s, d.work, margin * d.scale))
        })
    }

    /// First visit: the bottom-right corner of the work area, like the Mac.
    pub fn default_spot(d: &Display, size: f64, margin: f64) -> (f64, f64) {
        let s = size * d.scale;
        let m = margin * d.scale;
        (d.work.x + d.work.w - s - m, d.work.y + d.work.h - s - m)
    }

    /// Top-left corner of the window where his flight out starts: centred under
    /// the top edge of the folded panel window.
    pub fn launch_spot(anchor_x: f64, anchor_top: f64, size: f64, scale: f64) -> (f64, f64) {
        (anchor_x - size * scale / 2.0, anchor_top)
    }

    pub fn ease_in_out(t: f64) -> f64 {
        if t < 0.5 {
            4.0 * t * t * t
        } else {
            1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
        }
    }

    /// Ease-out with a small overshoot: the landing squash.
    pub fn ease_out_back(t: f64) -> f64 {
        let c1 = 1.3;
        let c3 = c1 + 1.0;
        1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
    }

    pub fn lerp(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
        (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
    }
}

use logic::{Display, Rect};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Carry {
    /// Cursor minus the window's top-left at pick-up (Poll mode), in logical
    /// pixels: scaled by the display he is over now, he stays under the pointer
    /// on a display of another scale (175% to 100%).
    grab: (f64, f64),
}

#[derive(Default)]
struct Inner {
    /// The window is on screen.
    shown: bool,
    /// Sitting on the desktop, taking pokes (not flying, not carried).
    landed: bool,
    asleep: bool,
    carry: Option<Carry>,
    /// Layer mode: the surface covers the display while it is dragged.
    overlay: bool,
    /// Top-left corner, in the mode's space.
    pos: (f64, f64),
    /// Layer mode: logical size of the display he lives on.
    display: Option<(f64, f64)>,
    /// Poll mode: the click-through state last applied.
    ignoring: Option<bool>,
}

pub struct Desktop {
    pub mode: DesktopMode,
    /// His window could not be made after all: off, whatever `mode` planned.
    failed: AtomicBool,
    gate: PollGate,
    inner: Mutex<Inner>,
    /// Bumped by every flight: an older one still running stops moving him.
    flight: AtomicU64,
}

impl Desktop {
    fn new(mode: DesktopMode) -> Self {
        Self {
            mode,
            failed: AtomicBool::new(false),
            gate: PollGate::new(),
            inner: Mutex::new(Inner::default()),
            flight: AtomicU64::new(0),
        }
    }
}

#[derive(Serialize, Clone)]
struct Cursor {
    x: f64,
    y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// "poll" | "window" | "layer" | "off".
    mode: &'static str,
    /// He was on the desktop when the app last quit.
    on_desktop: bool,
    /// His window is on screen now: a page that loaded after `desktop-visible`
    /// was sent (a buddy flies out at once) still learns it must draw.
    shown: bool,
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// His window's outer rectangle (physical x, y, width, height), only while he
/// is on screen: parked or hidden, there is nothing to open a panel beside.
pub fn shown_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let d = app.try_state::<Arc<Desktop>>()?;
    if !d.inner.lock().unwrap().shown {
        return None;
    }
    let win = window(app)?;
    let (p, s) = (win.outer_position().ok()?, win.outer_size().ok()?);
    Some((p.x as f64, p.y as f64, s.width as f64, s.height as f64))
}

fn body_disc() -> MouseShape {
    MouseShape::Disc { cx: SIZE / 2.0, cy: SIZE / 2.0, r: SIZE * logic::BODY_RADIUS_FRACTION }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

/// Same reasoning as the settings window: created hidden at launch, before the
/// panel's webview, then only shown and hidden. Nothing is created where the
/// feature is off.
pub fn setup(app: &AppHandle) {
    let planned = platform::desktop_mode();
    // Managed before his window is made. Making a window runs the message
    // loop, and the panel page's first calls are answered meanwhile: a
    // desktop_buddybara_info that found no state yet failed, and the page went
    // the whole session without him (a buddy never came out at all).
    let desktop = Arc::new(Desktop::new(planned));
    app.manage(desktop.clone());
    let mut mode = planned;
    if mode != DesktopMode::Off {
        match create_window(app, mode) {
            Some(win) if platform::prepare_desktop_window(&win, mode) => {}
            Some(win) => {
                let _ = win.destroy();
                mode = DesktopMode::Off;
            }
            None => mode = DesktopMode::Off,
        }
    }
    desktop.failed.store(mode != planned, Ordering::SeqCst);
    crate::log::line(format!("desktop Buddybara: {}", mode.as_str()));
    // Nothing takes the mouse until he is out.
    refresh(app, &desktop);
    if mode == DesktopMode::Poll {
        spawn_poll(app.clone(), desktop);
    }
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/buddybara.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("buddybara.html".into())
}

fn create_window(app: &AppHandle, _mode: DesktopMode) -> Option<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Buddybara")
        .inner_size(SIZE, SIZE)
        // GTK won't size a non-resizable window below its natural size (see
        // island::apply_geometry). Windows would grow resize borders instead.
        .resizable(cfg!(target_os = "linux"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .focusable(false)
        .visible(PARK);
    if PARK {
        builder = builder.position(PARKED.0, PARKED.1);
    }
    let built = builder.build();
    match built {
        Ok(win) => Some(win),
        Err(err) => {
            crate::log::line(format!("desktop Buddybara window failed: {err}"));
            None
        }
    }
}

// ── Coordinates ───────────────────────────────────────────────────────────────

/// Connected displays in the mode's space.
fn displays(app: &AppHandle, d: &Desktop) -> Vec<Display> {
    if d.mode == DesktopMode::Layer {
        let (w, h) = d.inner.lock().unwrap().display.unwrap_or((1920.0, 1080.0));
        let frame = Rect { x: 0.0, y: 0.0, w, h };
        return vec![Display { frame, work: frame, scale: 1.0 }];
    }
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    monitors
        .iter()
        .map(|m| {
            let (p, s, wa) = (m.position(), m.size(), m.work_area());
            Display {
                frame: Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 },
                work: Rect {
                    x: wa.position.x as f64,
                    y: wa.position.y as f64,
                    w: wa.size.width as f64,
                    h: wa.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// The panel window's top-centre point and the scale there, in the mode's
/// space: folded, it sits at his spot (or the first-visit corner), and his
/// flight out starts there.
fn panel_anchor(app: &AppHandle, d: &Desktop) -> Option<(f64, f64, f64)> {
    if d.mode == DesktopMode::Layer {
        let (w, _) = d.inner.lock().unwrap().display?;
        return Some((w / 2.0, 0.0, 1.0));
    }
    let win = island::window(app)?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    Some((pos.x as f64 + size.width as f64 / 2.0, pos.y as f64, scale))
}

/// Asks the GTK main thread for the panel's display (layer mode), and waits.
/// Never called from the main thread itself: every caller is a command that
/// runs on Tauri's async pool.
fn refresh_layer_display(app: &AppHandle, d: &Desktop) {
    if d.mode != DesktopMode::Layer {
        return;
    }
    let (Some(island), Some(buddybara)) = (island::window(app), window(app)) else { return };
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        let _ = tx.send(platform::layer_display(&island, &buddybara));
    });
    if let Ok(Some(size)) = rx.recv_timeout(Duration::from_secs(1)) {
        d.inner.lock().unwrap().display = Some(size);
    }
}

// ── Window operations ─────────────────────────────────────────────────────────

fn place(app: &AppHandle, d: &Desktop, pos: (f64, f64)) {
    d.inner.lock().unwrap().pos = pos;
    let Some(win) = window(app) else { return };
    match d.mode {
        DesktopMode::Poll | DesktopMode::Window => {
            let _ = win.set_position(PhysicalPosition::new(pos.0.round() as i32, pos.1.round() as i32));
        }
        DesktopMode::Layer => {
            let _ = app.run_on_main_thread(move || platform::set_layer_margins(&win, pos.0, pos.1));
        }
        DesktopMode::Off => {}
    }
}

fn show(app: &AppHandle, d: &Desktop, at: (f64, f64)) {
    place(app, d, at);
    d.inner.lock().unwrap().shown = true;
    if let Some(win) = window(app) {
        if !PARK {
            let _ = win.show();
        }
        island::raise(&win);
    }
    refresh(app, d);
    // The page draws only while he is on screen.
    let _ = app.emit_to(LABEL, "desktop-visible", true);
}

fn hide(app: &AppHandle, d: &Desktop) {
    {
        let mut i = d.inner.lock().unwrap();
        i.shown = false;
        i.landed = false;
        i.carry = None;
        i.asleep = false;
    }
    refresh(app, d);
    if PARK {
        place(app, d, PARKED);
    } else if let Some(win) = window(app) {
        let _ = win.hide();
    }
    let _ = app.emit_to(LABEL, "desktop-visible", false);
}

/// Re-derives the poll gate and what takes the mouse from the current state.
fn refresh(app: &AppHandle, d: &Desktop) {
    let (active, ignore, shape) = {
        let mut i = d.inner.lock().unwrap();
        let active = i.shown && (i.carry.is_some() || (i.landed && !i.asleep));
        // Poll mode: Some(flag) is decided here; None leaves it to the poll.
        let ignore = if !i.shown || (!i.landed && i.carry.is_none()) {
            Some(true)
        } else if i.carry.is_some() {
            Some(false)
        } else if i.asleep {
            // Asleep, nothing polls: the whole little window takes the mouse
            // and acts as his own wake area — the first move over it wakes
            // him, and the poll gives the rest back right away.
            Some(false)
        } else {
            None
        };
        if ignore.is_none() {
            i.ignoring = None;
        }
        let shape = if !i.shown || (!i.landed && i.carry.is_none()) {
            MouseShape::Empty
        } else if i.overlay {
            MouseShape::Whole
        } else {
            body_disc()
        };
        (active, ignore, shape)
    };
    let Some(win) = window(app) else { return };
    match d.mode {
        DesktopMode::Poll => {
            if let Some(flag) = ignore {
                d.inner.lock().unwrap().ignoring = Some(flag);
                let _ = win.set_ignore_cursor_events(flag);
            }
            d.gate.set_active(active);
        }
        DesktopMode::Window | DesktopMode::Layer => {
            let _ = app.run_on_main_thread(move || platform::set_desktop_shape(&win, shape));
        }
        DesktopMode::Off => {}
    }
}

/// Moves him from where he is to `to`, then lands him. False when another
/// flight took over before the end.
async fn fly(app: &AppHandle, d: &Desktop, to: (f64, f64), ms: u64, ease: fn(f64) -> f64) -> bool {
    let token = d.flight.fetch_add(1, Ordering::SeqCst) + 1;
    let from = d.inner.lock().unwrap().pos;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let d = app2.state::<Arc<Desktop>>();
        let steps = (ms / TICK_MS).max(1);
        for k in 1..=steps {
            if d.flight.load(Ordering::SeqCst) != token {
                let _ = tx.send(false);
                return;
            }
            let t = k as f64 / steps as f64;
            place(&app2, &d, logic::lerp(from, to, ease(t)));
            std::thread::sleep(Duration::from_millis(TICK_MS));
        }
        let _ = tx.send(d.flight.load(Ordering::SeqCst) == token);
    });
    rx.await.unwrap_or(false)
}

/// Saves what changed about him in the preferences.
fn remember(app: &AppHandle, change: impl FnOnce(&mut settings::DesktopBuddybaraPref)) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let snapshot = {
        let mut s = shared.settings.lock().unwrap();
        change(&mut s.desktop_buddybara);
        s.clone()
    };
    if let Err(err) = settings::save(&snapshot) {
        crate::log::line(format!("could not save settings: {err}"));
    }
}

fn remember_spot(app: &AppHandle, d: &Desktop, pos: (f64, f64), on_desktop: bool) {
    let space = d.mode.space().to_string();
    remember(app, |p| {
        p.on_desktop = on_desktop;
        p.spot = Some(DesktopSpot { x: pos.0, y: pos.1, space });
    });
}

/// Where he lands when he flies out, or `None` when his spot is on a display
/// that is no longer connected — unless `anywhere`, the user sending him out
/// with the desktop shortcut: then the first-visit corner.
fn target_spot(app: &AppHandle, d: &Desktop, anywhere: bool) -> Option<(f64, f64)> {
    let all = displays(app, d);
    let saved = app.try_state::<crate::Shared>().and_then(|s| s.settings.lock().unwrap().desktop_buddybara.spot.clone());
    // A fresh start in the corner of the panel's display.
    let corner = || {
        let (cx, top, _) = panel_anchor(app, d)?;
        let home = logic::display_near((cx, top + 1.0), &all)?;
        Some(logic::default_spot(&home, SIZE, MARGIN))
    };
    match saved {
        Some(spot) if spot.space == d.mode.space() => {
            let restored = logic::restore_spot((spot.x, spot.y), &all, SIZE, MARGIN);
            if anywhere { restored.or_else(corner) } else { restored }
        }
        // Never placed, or placed under another kind of session.
        _ => corner(),
    }
}

/// The drop: his new spot, settled inside the work area of the display under him.
async fn finish_drop(app: &AppHandle, d: &Desktop, pos: (f64, f64)) {
    {
        let mut i = d.inner.lock().unwrap();
        i.carry = None;
        i.landed = true;
    }
    let spot = logic::settle(pos, &displays(app, d), SIZE, MARGIN);
    refresh(app, d);
    if spot != pos {
        fly(app, d, spot, SNAP_MS, logic::ease_out_back).await;
    }
    remember_spot(app, d, spot, true);
    // The panel opens beside his new spot now.
    let _ = app.emit_to(island::WINDOW_LABEL, "desktop-buddybara-dropped", ());
}

// ── Poll (Windows) ────────────────────────────────────────────────────────────

/// Runs only while he is awake on the desktop or being carried: click-through
/// from the body hit test, the cursor for his eyes, and the drag.
fn spawn_poll(app: AppHandle, d: Arc<Desktop>) {
    std::thread::spawn(move || loop {
        d.gate.wait_until_active();
        let mut last = (f64::MIN, f64::MIN);
        while d.gate.is_active() {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            let Some(win) = window(&app) else { continue };
            let Some((cx, cy)) = platform::cursor_physical() else { continue };
            let carry = d.inner.lock().unwrap().carry;

            if let Some(c) = carry {
                let scale = win.scale_factor().unwrap_or(1.0);
                let pos = (cx - c.grab.0 * scale, cy - c.grab.1 * scale);
                if platform::left_button_down() {
                    if pos != d.inner.lock().unwrap().pos {
                        place(&app, &d, pos);
                        island::follow_buddybara(&app);
                    }
                } else {
                    // Released: hand the drop to the async pool, where the
                    // snap animation may wait.
                    d.inner.lock().unwrap().carry = None;
                    let app2 = app.clone();
                    let d2 = d.clone();
                    tauri::async_runtime::spawn(async move { finish_drop(&app2, &d2, pos).await });
                }
                continue;
            }
            // Between a release and the drop being settled, nothing to decide.
            if !d.inner.lock().unwrap().landed {
                continue;
            }

            let Ok(origin) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let local = ((cx - origin.x as f64) / scale, (cy - origin.y as f64) / scale);
            // A file dragged onto him must find his window, and
            // click-through hides it from OLE's hit test (the drop would land
            // on whatever is below). While a button is held over all of him as
            // drawn, that takes the mouse too (the panel's own rule, island.rs);
            // the empty corners of his window stay see-through, for drops meant
            // for what is under them. A press that started elsewhere keeps its
            // capture there. Elsewhere his page takes no files at all.
            let over_him = logic::is_within(local, SIZE, logic::FIGURE_RADIUS_FRACTION);
            let accept = logic::is_over_body(local, SIZE)
                || logic::is_over_hide_button(local)
                || (over_him && platform::left_button_down());
            {
                let mut i = d.inner.lock().unwrap();
                // refresh() may have taken over during this tick's sleep: he
                // dozed off (his whole window takes the mouse, as his own wake
                // area), was hidden, or picked up. Its word stands. Applied over
                // it, he would sleep see-through with nothing polling, and no
                // click or drag could reach him until something else woke him.
                if i.asleep || !i.landed || i.carry.is_some() {
                    continue;
                }
                if i.ignoring != Some(!accept) {
                    i.ignoring = Some(!accept);
                    let _ = win.set_ignore_cursor_events(!accept);
                }
            }
            if (local.0 - last.0).abs() >= 1.0 || (local.1 - last.1).abs() >= 1.0 {
                last = local;
                let _ = win.emit("desktop-cursor", Cursor { x: local.0, y: local.1 });
            }
        }
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn desktop_buddybara_info(app: AppHandle, desktop: State<Arc<Desktop>>) -> DesktopInfo {
    let on_desktop = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().desktop_buddybara.on_desktop)
        .unwrap_or(false);
    let mode = if desktop.failed.load(Ordering::SeqCst) { DesktopMode::Off } else { desktop.mode };
    DesktopInfo {
        mode: mode.as_str(),
        on_desktop: on_desktop && mode != DesktopMode::Off,
        shown: desktop.inner.lock().unwrap().shown,
    }
}

/// The page saw a drag start on Buddybara. Returns his top-left corner in the
/// mode's space, which the page needs to draw him in the overlay (layer mode).
#[tauri::command]
pub async fn desktop_buddybara_drag_begin(app: AppHandle) -> Option<(f64, f64)> {
    let d = app.state::<Arc<Desktop>>().inner().clone();
    let pos = {
        let i = d.inner.lock().unwrap();
        if !i.landed || i.carry.is_some() {
            return None;
        }
        i.pos
    };
    // A drag takes over from a snap still settling him.
    d.flight.fetch_add(1, Ordering::SeqCst);
    match d.mode {
        DesktopMode::Poll => {
            let win = window(&app)?;
            let (cx, cy) = platform::cursor_physical()?;
            let origin = win.outer_position().ok()?;
            let scale = win.scale_factor().unwrap_or(1.0);
            let grab = ((cx - origin.x as f64) / scale, (cy - origin.y as f64) / scale);
            d.inner.lock().unwrap().carry = Some(Carry { grab });
            refresh(&app, &d);
        }
        DesktopMode::Layer => {
            d.inner.lock().unwrap().overlay = true;
            let win = window(&app)?;
            let _ = app.run_on_main_thread(move || {
                platform::set_layer_overlay(&win, true);
                platform::set_desktop_shape(&win, MouseShape::Whole);
            });
        }
        _ => {}
    }
    Some(pos)
}

/// X11: the page moves the window during its drag (top-left, physical pixels).
#[tauri::command]
pub async fn desktop_buddybara_drag_move(app: AppHandle, x: f64, y: f64) {
    let d = app.state::<Arc<Desktop>>().inner().clone();
    if d.mode == DesktopMode::Window && d.inner.lock().unwrap().landed {
        place(&app, &d, (x, y));
        island::follow_buddybara(&app);
    }
}

/// Linux: the page's drag ended with the top-left corner at (`x`, `y`), in the
/// mode's space. On Windows the poll sees the release itself.
#[tauri::command]
pub async fn desktop_buddybara_drag_end(app: AppHandle, x: f64, y: f64) {
    let d = app.state::<Arc<Desktop>>().inner().clone();
    if d.mode == DesktopMode::Poll || !d.inner.lock().unwrap().landed {
        return;
    }
    if d.mode == DesktopMode::Layer {
        d.inner.lock().unwrap().overlay = false;
        if let Some(win) = window(&app) {
            let _ = app.run_on_main_thread(move || {
                platform::set_layer_overlay(&win, false);
                platform::set_layer_margins(&win, x, y);
            });
        }
        if let Some(win) = window(&app) {
            let _ = win.set_size(tauri::LogicalSize::new(SIZE, SIZE));
        }
    }
    place(&app, &d, (x, y));
    finish_drop(&app, &d, (x, y)).await;
}

/// Launch: from the folded panel to his spot. False when the spot is on a
/// display that is gone — he then stays put away, and is forgotten there so the
/// next launch doesn't try again. `anywhere` lands him in the first-visit
/// corner instead.
#[tauri::command]
pub async fn desktop_buddybara_fly_out(app: AppHandle, anywhere: Option<bool>) -> bool {
    let d = app.state::<Arc<Desktop>>().inner().clone();
    if d.mode == DesktopMode::Off || window(&app).is_none() {
        return false;
    }
    refresh_layer_display(&app, &d);
    let Some(target) = target_spot(&app, &d, anywhere.unwrap_or(false)) else {
        crate::log::line("desktop Buddybara: his spot is on a display that is gone");
        remember(&app, |p| p.on_desktop = false);
        return false;
    };
    let Some((cx, top, scale)) = panel_anchor(&app, &d) else {
        crate::log::line("desktop Buddybara: no panel window to fly out of");
        return false;
    };
    let start = logic::launch_spot(cx, top, SIZE, scale);
    {
        let mut i = d.inner.lock().unwrap();
        i.landed = false;
        i.carry = None;
        i.asleep = false;
    }
    show(&app, &d, start);
    let _ = app.emit_to(LABEL, "desktop-flight", "out");
    if !fly(&app, &d, target, FLIGHT_MS, logic::ease_in_out).await {
        crate::log::line("desktop Buddybara: flight out cut short");
        return false;
    }
    d.inner.lock().unwrap().landed = true;
    refresh(&app, &d);
    remember_spot(&app, &d, target, true);
    true
}

/// Where the panel's funnel meets him (src/buddy/genie.ts) — the
/// edge of his body facing the panel, in the panel window's logical pixels.
/// None while he is off screen.
#[tauri::command]
pub fn desktop_buddybara_anchor(app: AppHandle) -> Option<(f64, f64)> {
    let (mx, my, mw, mh) = shown_rect(&app)?;
    let win = island::window(&app)?;
    let (p, s) = (win.outer_position().ok()?, win.outer_size().ok()?);
    let scale = win.scale_factor().ok()?;
    let (cx, cy) = (mx + mw / 2.0, my + mh / 2.0);
    let r = mw * logic::BODY_RADIUS_FRACTION;
    let toward_panel = if cx > p.x as f64 + s.width as f64 / 2.0 { -r } else { r };
    Some(((cx + toward_panel - p.x as f64) / scale, (cy - p.y as f64) / scale))
}

/// His minimize button: off the screen at once, his spot kept.
/// Buddybara runs on; started again, he flies back out (DesktopLink.summon).
#[tauri::command]
pub fn desktop_buddybara_put_away(app: AppHandle) {
    let d = app.state::<Arc<Desktop>>().inner().clone();
    if d.inner.lock().unwrap().shown {
        hide(&app, &d);
    }
}

/// The page dozed off (or woke up). Asleep, nothing polls.
#[tauri::command]
pub fn desktop_buddybara_set_asleep(app: AppHandle, desktop: State<Arc<Desktop>>, asleep: bool) {
    let changed = {
        let mut i = desktop.inner.lock().unwrap();
        let changed = i.asleep != asleep;
        i.asleep = asleep;
        changed
    };
    if changed {
        refresh(&app, &desktop);
    }
}

#[cfg(test)]
mod tests {
    use super::logic::*;

    // Mirrors tests/DesktopBuddybaraTests.swift (isOverBody, clampOrigin), in the
    // y-down coordinates every PC uses.

    #[test]
    fn is_over_body() {
        let s = 120.0;
        let r = s * BODY_RADIUS_FRACTION; // 28.8
        assert!(super::logic::is_over_body((60.0, 60.0), s), "center must be inside body");
        assert!(super::logic::is_over_body((60.0 + r - 0.5, 60.0), s), "inside radius must hit");
        assert!(!super::logic::is_over_body((60.0 + r + 0.5, 60.0), s), "outside radius must miss");
        assert!(!super::logic::is_over_body((0.0, 0.0), s), "corner must miss");
        let diag = r / 2f64.sqrt() - 0.5;
        assert!(super::logic::is_over_body((60.0 + diag, 60.0 + diag), s), "diagonal inside must hit");
        assert!(super::logic::is_over_body((60.0 - diag, 60.0 + diag), s), "every quadrant");
    }

    #[test]
    fn his_minimize_button_takes_the_click_beside_his_head_but_not_his_body() {
        use super::logic::{is_over_body, is_over_hide_button};
        assert!(is_over_hide_button((94.0, 28.0)) && is_over_hide_button((100.0, 34.0)));
        assert!(!is_over_hide_button((60.0, 60.0)) && !is_over_hide_button((118.0, 2.0)));
        assert!(!is_over_body((94.0, 28.0), 120.0));
    }

    #[test]
    fn a_file_dragged_onto_him_is_taken_over_all_of_him_but_never_in_the_empty_corners() {
        use super::logic::{is_within, FIGURE_RADIUS_FRACTION as F};
        let s = 120.0;
        // His hat and hands, beyond the body circle, take it.
        assert!(is_within((60.0, 60.0 - 45.0), s, F) && is_within((60.0 + 45.0, 60.0), s, F));
        assert!(!super::logic::is_over_body((60.0, 60.0 - 45.0), s));
        // The corners of his square window let it through to what is under him.
        for corner in [(2.0, 2.0), (118.0, 2.0), (2.0, 118.0), (118.0, 118.0), (10.0, 10.0)] {
            assert!(!is_within(corner, s, F), "{corner:?}");
        }
    }

    #[test]
    fn clamp_origin_keeps_him_inside_the_work_area() {
        // A 1440×900 display with a 40 px taskbar at the bottom.
        let work = Rect { x: 0.0, y: 0.0, w: 1440.0, h: 860.0 };
        let (s, m) = (120.0, 24.0);
        assert_eq!(clamp_origin((600.0, 400.0), s, work, m), (600.0, 400.0), "in-bounds origin must be unchanged");
        assert_eq!(clamp_origin((-50.0, 400.0), s, work, m).0, work.x + m, "too-left");
        assert_eq!(clamp_origin((2000.0, 400.0), s, work, m).0, work.x + work.w - s - m, "too-right");
        assert_eq!(clamp_origin((400.0, -50.0), s, work, m).1, work.y + m, "too-high");
        assert_eq!(clamp_origin((400.0, 2000.0), s, work, m).1, work.y + work.h - s - m, "too-low: above the taskbar");
    }

    fn two_displays() -> Vec<Display> {
        // A 1920×1080 laptop at 100 %, and a 4K monitor at 200 % on its right,
        // physical pixels; both with a 48 px taskbar at the bottom.
        let a = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
        let b = Rect { x: 1920.0, y: -200.0, w: 3840.0, h: 2160.0 };
        vec![
            Display { frame: a, work: Rect { h: 1032.0, ..a }, scale: 1.0 },
            Display { frame: b, work: Rect { h: 2064.0, ..b }, scale: 2.0 },
        ]
    }

    #[test]
    fn a_spot_on_a_connected_display_is_kept() {
        let d = two_displays();
        assert_eq!(restore_spot((800.0, 600.0), &d, 120.0, 24.0), Some((800.0, 600.0)));
        // On the second display, sized in its own scale.
        assert_eq!(restore_spot((3000.0, 1000.0), &d, 120.0, 24.0), Some((3000.0, 1000.0)));
    }

    #[test]
    fn a_spot_on_a_display_that_is_gone_brings_him_home() {
        let d = two_displays();
        // Left of the laptop: a monitor that has been unplugged.
        assert_eq!(restore_spot((-1500.0, 300.0), &d, 120.0, 24.0), None);
        // Nothing connected at all.
        assert_eq!(restore_spot((800.0, 600.0), &[], 120.0, 24.0), None);
        // Only the first display left: the spot on the second is gone.
        assert_eq!(restore_spot((3000.0, 1000.0), &d[..1], 120.0, 24.0), None);
    }

    #[test]
    fn a_spot_that_a_taller_taskbar_now_covers_moves_up() {
        let d = two_displays();
        let (x, y) = restore_spot((800.0, 1000.0), &d, 120.0, 24.0).unwrap();
        assert_eq!(x, 800.0);
        assert_eq!(y, 1032.0 - 120.0 - 24.0);
        // The 200 % display clamps with its own scale.
        let (_, y) = restore_spot((3000.0, 1700.0), &d, 120.0, 24.0).unwrap();
        assert_eq!(y, -200.0 + 2064.0 - 240.0 - 48.0);
    }

    #[test]
    fn a_drop_settles_on_the_display_under_him() {
        let d = two_displays();
        // Dropped against the right edge of the laptop: stays on the laptop.
        assert_eq!(settle((1800.0, 500.0), &d, 120.0, 24.0), (1920.0 - 120.0 - 24.0, 500.0));
        // His centre already over the next display: he moves onto it.
        assert_eq!(settle((1870.0, 500.0), &d, 120.0, 24.0), (1920.0 + 48.0, 500.0));
        // Dropped in the gap above the laptop, next to the taller monitor:
        // nearest display.
        let (x, y) = settle((1000.0, -150.0), &d, 120.0, 24.0);
        assert_eq!((x, y), (1000.0, 24.0));
    }

    #[test]
    fn first_visit_is_the_bottom_right_corner() {
        let d = two_displays();
        assert_eq!(default_spot(&d[0], 120.0, 24.0), (1920.0 - 144.0, 1032.0 - 144.0));
        assert_eq!(default_spot(&d[1], 120.0, 24.0), (1920.0 + 3840.0 - 288.0, -200.0 + 2064.0 - 288.0));
    }

    #[test]
    fn he_flies_out_from_under_the_top_centre_of_the_folded_panel() {
        assert_eq!(launch_spot(960.0, 0.0, 120.0, 1.0), (900.0, 0.0));
        assert_eq!(launch_spot(2880.0, -200.0, 120.0, 2.0), (2760.0, -200.0));
    }

    #[test]
    fn flights_start_and_end_where_asked() {
        for ease in [ease_in_out as fn(f64) -> f64, ease_out_back] {
            assert!(ease(0.0).abs() < 1e-9);
            assert!((ease(1.0) - 1.0).abs() < 1e-9);
        }
        assert!(ease_out_back(0.7) > 1.0, "the landing overshoots a little");
        assert_eq!(lerp((0.0, 10.0), (100.0, 20.0), 0.5), (50.0, 15.0));
    }
}
