// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure DAC / voltage math for the MEMS mirror controller, shared by the renderer
// `Controller.vue` and the orchestrator controller. Dependency-free (own tiny
// `clamp`) so it loads in any process — no Vue/Electron.

export type Pos = { x: number; y: number };

export const origin: { left: Pos; right: Pos } = {
  left: { x: 0, y: 0 },
  right: { x: 0, y: 0 },
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function volt2dac(volt: number): number {
  return clamp((65535 * volt) / 200, 0, 65535) | 0;
}

export function dac2volt(dac: number): number {
  return (200 * dac) / 65535;
}

function ch(volt: number, bias: number, dv: number): [number, number] {
  const v = clamp(volt / 2, -dv, dv);
  return [volt2dac(bias + v), volt2dac(bias - v)];
}

export function channels(
  pos: Pos,
  bias: number,
  dv: number,
): [number, number, number, number] {
  const { x, y } = pos;
  return [...ch(x, bias, dv / 2), ...ch(y, bias, dv / 2)];
}
