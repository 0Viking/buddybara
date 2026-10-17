// Buddybara runs without a console window: Buddybara is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    buddybara_lib::run()
}
