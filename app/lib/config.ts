// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import Store from "./store.js";

export interface AppConfig {
    divergence_kp: number;
    divergence_template_match_scale: number;
}

export function useAppConfig() {
    return Store.open<AppConfig>("config");
}
