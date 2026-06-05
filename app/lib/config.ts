// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import Store from "./store.js";
import { useDefaults } from "./util/index.js";

export interface AppConfig {
  // TeleCanvas Server URL
  tele_canvas_url?: string;
  // Camera Layout Configurations
  baseline_distance_mm: number;
  cal_marker_size_mm: number;
  cal_marker_ratio: number;
  // Capture Configurations
  cap_stack: number;
}

export async function useAppConfig() {
  return useDefaults<AppConfig>(await Store.open<AppConfig>("config"), {
    get baseline_distance_mm() {
      return 200.0;
    },
    get cal_marker_size_mm() {
      return 60.0;
    },
    get cal_marker_ratio() {
      return 1.0;
    },
    get cap_stack() {
      return 5;
    },
  });
}
