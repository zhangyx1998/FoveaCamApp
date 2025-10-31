// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { clamp } from "./util";

class Swatch extends Array<string> {
    at(index: number) {
        return this[index % this.length];
    }
}

export default function rainbow(brightness: number) {
    const bri = clamp(brightness, [0, 100]) + "%";
    return new Swatch(
        `hsl(0, 100%, ${bri})`,
        `hsl(30, 100%, ${bri})`,
        `hsl(60, 100%, ${bri})`,
        `hsl(120, 100%, ${bri})`,
        `hsl(180, 100%, ${bri})`,
        `hsl(240, 100%, ${bri})`,
        `hsl(270, 100${bri}%`
    );
}

export const light_rainbow = rainbow(70);

export const dark_rainbow = rainbow(40);
