import { NavLink, Route, Routes } from "react-router-dom";

import DashboardPage from "./pages/DashboardPage";

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Enterprise AI Platform</span>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
        </Routes>
      </main>
    </div>
  );
}
