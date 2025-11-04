// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import Store from "./store";

export interface AppConfig {
    zoom_factor: number;
}

export function useAppConfig() {
    return Store.open<AppConfig>("config");
}
