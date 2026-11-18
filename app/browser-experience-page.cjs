"use strict";
// Only structured checks cross into a page. No imported script is ever evaluated.
const fail = (message, code = "WIEK_EXPERIENCE_PRECONDITION") =>
  Object.assign(new Error(message), { error_code: code });
function createExperiencePage({
  contents,
  assertControl,
  origin,
  dispatchInput,
}) {
  const currentUrl = () => contents.getURL();
  async function bounded(operation) {
    let timer, guard;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              fail(
                "Operation check timed out; input may have late effects",
                "WIEK_EXPERIENCE_TIMEOUT",
              ),
            ),
          5000,
        );
        guard = setInterval(() => {
          try {
            assertControl();
          } catch (error) {
            reject(error);
          }
        }, 40);
        Promise.resolve().then(operation).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      clearInterval(guard);
    }
  }

  async function evaluate(operation, argument) {
    assertControl();
    const before = currentUrl();
    if (new URL(before).origin !== origin) throw fail("Page origin changed");
    const result = await bounded(() =>
      contents.executeJavaScriptInIsolatedWorld(998, [
        { code: `(${operation.toString()})(${JSON.stringify(argument)})` },
      ]),
    );
    assertControl();
    if (currentUrl() !== before)
      throw fail("Page changed during operation check");
    return result;
  }
  async function check(checks) {
    return evaluate(
      (rows) =>
        rows.every((row) => {
          if (row.kind === "url") return location.pathname === row.path;
          let matches;
          try {
            matches = document.querySelectorAll(row.selector);
          } catch {
            return false;
          }
          if (matches.length !== 1) return false;
          const element = matches[0];
          if (element.matches("input,textarea,[contenteditable],select"))
            return false;
          const actual =
            row.attribute === "text"
              ? (element.textContent || "").trim()
              : element.getAttribute(row.attribute);
          return actual === row.equals;
        }),
      checks,
    );
  }
  async function execute(recipe) {
    assertControl();
    if (new URL(currentUrl()).origin !== origin)
      throw fail("Page origin changed");
    if (recipe.type === "navigate") {
      const url = new URL(recipe.path, origin);
      if (url.origin !== origin)
        throw fail("Navigation left the allowed origin");
      await bounded(() => contents.loadURL(url.href));
      return;
    }
    const point = await evaluate((row) => {
      let matches;
      try {
        matches = document.querySelectorAll(row.selector);
      } catch {
        return null;
      }
      if (matches.length !== 1) return null;
      const e = matches[0];
      if (
        e.tagName.toLowerCase() !== row.tag ||
        (e.textContent || "").trim() !== row.text ||
        (row.role && e.getAttribute("role") !== row.role) ||
        e.matches(
          ':disabled,[aria-disabled="true"],input,textarea,select,[contenteditable]',
        )
      )
        return null;
      e.scrollIntoView({ block: "center", inline: "center" });
      const r = e.getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      if (
        !r.width ||
        !r.height ||
        x < 0 ||
        y < 0 ||
        x >= innerWidth ||
        y >= innerHeight ||
        !e.contains(document.elementFromPoint(x, y))
      )
        return null;
      return { x: Math.round(x), y: Math.round(y) };
    }, recipe);
    if (!point)
      throw fail(
        "The unique visible target no longer matches its reviewed text and role",
      );
    assertControl();
    await bounded(() =>
      dispatchInput("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      }),
    );
    assertControl();
    await bounded(() =>
      dispatchInput("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      }),
    );
    assertControl();
    await bounded(() =>
      dispatchInput("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      }),
    );
    // No second dispatch: wait only for observable application state to settle.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (await check(recipe.after)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  return { check, execute, currentUrl };
}
module.exports = { createExperiencePage };
