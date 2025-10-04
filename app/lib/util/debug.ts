// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { camel2dash } from "./string";

class StackFrame {
    constructor(
        public readonly identity: string = "",
        public readonly location: string = ""
    ) {}
    get short_location(): string {
        const path = this.location.split("/").pop() ?? this.location;
        const [name, ...rest] = path.split(":");
        return [name.split("?")[0], ...rest].join(":");
    }
    static from(line: string): StackFrame | null {
        const format = this.inferFormat(line);
        if (format === "V8") return this.parseV8(line);
        if (format === "Gecko") return this.parseGecko(line);
        return null;
    }
    private static inferFormat(line: string): "V8" | "Gecko" | null {
        if (/^\s*at\s+/.test(line)) return "V8";
        if (line.includes("@")) return "Gecko";
        return null;
    }
    // V8 (Chrome, Node.js)
    private static parseV8(line: string): StackFrame {
        const m = line.match(/^\s*at\s+(.*?)\s*\((.*)\)\s*$/);
        if (m) {
            // "at func (proto://xxx:line:col)"
            const [id = "", loc = ""] = m.slice(1).map((s) => s.trim());
            return new StackFrame(id, loc);
        } else {
            // "at proto://xxx:line:col"
            return new StackFrame("", line.replace(/^\s*at\s*/, "").trim());
        }
    }
    // Safari, Firefox
    private static parseGecko(line: string): StackFrame {
        const [id = "", loc = ""] = line.split("@").map((s) => s.trim());
        return new StackFrame(id, loc);
    }
    // Render as color console log
    render() {
        return [
            "%c%c%s%c%s\t%c%s",
            $("background: black;"),
            $("color: lightyellow"),
            this.identity,
            $("color: gray"),
            this.identity ? "()" : "[Global Code]",
            $("color: gray; text-decoration: underline;"),
            this.short_location,
        ];
    }
}

const ConsoleGroup = {
    *collapsed(...args: any[]) {
        console.groupCollapsed(...args);
        try {
            yield;
        } finally {
            console.groupEnd();
        }
    },
    *expanded(...args: any[]) {
        console.group(...args);
        try {
            yield;
        } finally {
            console.groupEnd();
        }
    },
};

// Apply default styles
const $ = (...s: string[]) => ["font-weight: normal;", ...s].join(";");

class Trace extends Error {
    get stack() {
        return super.stack ?? "";
    }
    public readonly frames: readonly StackFrame[];
    public readonly title: string;
    constructor(
        public readonly func: Function = Trace,
        public readonly args: any[] | Record<string, any> = []
    ) {
        super();
        Error.captureStackTrace?.(this, func);
        this.title = func.name || "<anonymous function>";
        this.name = "Stack Trace of " + this.title + (func.name ? "(...)" : "");
        this.frames = this.stack
            .split("\n")
            .slice(1)
            .map((l) => StackFrame.from(l))
            .filter((f) => f instanceof StackFrame);
    }

    renderHead() {
        let template = "%c%s%c(";
        const contents = ["color: #ffe17eff;", this.title, $("")];
        const argc = Object.entries(this.args).length;
        if (Array.isArray(this.args)) {
            this.args.forEach((v, i, arr) => {
                template += "%c%o";
                contents.push($("color: lightbrown;"), v);
                if (i === arr.length - 1) return;
                template += "%c, ";
                contents.push($(""));
            });
        } else {
            if (argc > 1) template += "\n  ";
            const w = Math.max(...Object.keys(this.args).map((k) => k.length));
            Object.entries(this.args).forEach(([k, v], i, arr) => {
                template += "%c%s = %c%o";
                contents.push(
                    $("font-style: italic;"),
                    k.padEnd(w),
                    $("color: lightbrown;"),
                    v
                );
                if (i === arr.length - 1) return;
                template += "%c,\n  ";
                contents.push($(""));
            });
            if (argc > 1) template += "\n";
        }
        return [template + "%c)", ...contents, $("")];
    }

    print(collapse: boolean = true) {
        const group = collapse ? ConsoleGroup.collapsed : ConsoleGroup.expanded;
        for (const _ of group(...this.renderHead()))
            for (const frame of this.frames)
                for (const _ of group(...frame.render()))
                    console.log(frame.location);
        return this;
    }

    *capture(collapse: boolean = true) {
        const group = collapse ? ConsoleGroup.collapsed : ConsoleGroup.expanded;
        for (const _ of group(...this.renderHead())) {
            for (const _ of group("Stack Trace"))
                for (const frame of this.frames)
                    for (const _ of group(...frame.render()))
                        console.log(frame.location);
            let ret_value: any,
                ret_frame: StackFrame | null = null;
            try {
                function captureReturn<T>(ret: T): T {
                    ret_value = ret;
                    ret_frame = new Trace(captureReturn).frames[0];
                    return ret;
                }
                for (const _ of group("Captured Logs")) yield captureReturn;
            } finally {
                if (ret_frame) {
                    const contents = [
                        "%creturn %c%o",
                        $("color: #b47eb5ff"),
                        $(""),
                        ret_value,
                    ];
                    for (const _ of group(...contents))
                        console.log((ret_frame as StackFrame).location);
                } else {
                    console.log(
                        "%creturn %c <not captured> ",
                        $("color: #b47eb5ff"),
                        $("color: #A88; background: #333")
                    );
                }
            }
        }
    }
}

export default class Debug {
    static readonly GC = new FinalizationRegistry<string>((heldValue) => {
        console.log("%c%s", "color: gray;", "<destructed>", heldValue);
    });

    static trackGC(obj: object, name: string) {
        this.GC.register(obj, name);
    }

    static trace(capture: Function = Debug.trace, ...args: any[]) {
        return new Trace(capture, ...args);
    }

    static banner(
        msg: string,
        styles: Record<string, string> = {},
        border: string = "-"
    ) {
        const css = Object.entries(styles)
            .filter(([, v]) => v.trim() !== "")
            .map(([k, v]) => `${camel2dash(k)}: ${v};`)
            .join(" ");
        const lines = msg.split("\n");
        if (border) {
            const line = border.repeat(Math.max(...lines.map((l) => l.length)));
            lines.unshift(line);
            lines.push(line);
        }
        console.log("%c%s", css, lines.map((l) => ` ${l} `).join("\n"));
    }
}
