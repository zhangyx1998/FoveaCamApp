// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
declare module "core/Regression" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    // default: { ply: [2, 1, 0, -1, -2] }
    // For input of {x, y}, will expand to:
    // [x^2, y^2, xy, x, y, 1, 1/x, 1/y, 1/x^2, 1/y^2, 1/xy]
    type RegressionConfig = {
        ply: number[]; // polynomial degrees to expand
        log: number[]; // logarithmic degrees to expand
        exp: number[]; // exponential degrees to expand
    };

    export default class Regression<
        I extends Record<string, number>,
        O extends Record<string, number>
    > {
        constructor(
            features: (keyof I)[],
            targets: (keyof O)[],
            config?: RegressionConfig
        );
        fit(i: I[], o: O[]): this;
        expand(i: I): number[];
        predict(i: I): O;
        get features(): (keyof I)[];
        get targets(): (keyof O)[];
        get expansions(): string[];
        get parameters(): Record<keyof O, number[]>;
        toString(): string;
    }
}
