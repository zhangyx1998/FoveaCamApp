import { describe, expect, it } from "vitest";
import { APPS, allEntries, appById } from "@lib/windows";
import { appComponents } from "@src/windows/app-registry";

const sorted = (values: Iterable<string>) => [...values].sort();

describe("app registry", () => {
  it("keeps the explicit component loader map in sync with the app catalog", () => {
    const launchableIds = APPS.filter((a) => !a.dev || import.meta.env.DEV).map(
      (a) => a.id,
    );

    expect(sorted(Object.keys(appComponents))).toEqual(sorted(launchableIds));
    for (const id of Object.keys(appComponents)) expect(appById(id)).toBeTruthy();
  });

  it("emits one renderer entry per catalog app", () => {
    const entries = allEntries();
    for (const app of APPS) {
      expect(entries[app.id]).toBe(`windows/${app.id}.html`);
    }
  });
});
