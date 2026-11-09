/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Disable preflight so Tailwind's reset doesn't fight antd's styles.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      fontFamily: {
        sans: ["Hanken Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        disp: ["Bricolage Grotesque", "Hanken Grotesk", "sans-serif"],
      },
      colors: {
        paper: "#f4f2ec",
        "paper-2": "#efece4",
        card: "#fbfaf6",
        "card-2": "#ffffff",
        line: "#e0ddd2",
        "line-strong": "#c9c5b6",
        ink: "#1d2421",
        "ink-2": "#515a54",
        "ink-3": "#8c918a",
        pine: "#145e4b",
        "pine-bright": "#1c7a62",
        "pine-soft": "#e3efe9",
        "pine-ghost": "#eef5f1",
        run: "#b4530d",
        "run-soft": "#fbe9d9",
        done: "#14654f",
        "done-soft": "#dcefe6",
        fail: "#a51f2d",
        "fail-soft": "#f6e0e0",
        skip: "#6b6f67",
        "skip-soft": "#e8e6dd",
        stop: "#4c4f56",
        "stop-soft": "#e5e6e9",
      },
      borderRadius: { sm: "6px", DEFAULT: "9px", lg: "13px" },
      boxShadow: {
        sm: "0 1px 2px rgba(28,36,33,.05), 0 1px 1px rgba(28,36,33,.04)",
        md: "0 2px 4px rgba(28,36,33,.05), 0 8px 20px -8px rgba(28,36,33,.14)",
        lg: "0 24px 60px -18px rgba(20,40,33,.30), 0 4px 14px -6px rgba(28,36,33,.16)",
      },
    },
  },
  plugins: [],
};
