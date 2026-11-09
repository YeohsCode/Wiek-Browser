import React from "react";
import ReactDOM from "react-dom/client";
import AppProviders from "./AppProviders";
import "antd/dist/reset.css";
import "./index.css";

// Pine-ink Lab Console theme: deep pine accent on warm paper.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders />
  </React.StrictMode>
);
