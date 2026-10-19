import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import NavBar from "./components/NavBar";
import Footer from "./components/Footer";
import { AuthProvider } from "./context/AuthContext";
import { TournamentProvider } from "./context/TournamentContext";
import Landing from "./pages/Landing";
import Leaderboard from "./pages/Leaderboard";
import Stats from "./pages/Stats";
import AdminLocal from "./pages/AdminLocal";
import Devices from "./pages/Devices";
import MyProfile from "./pages/MyProfile";
import Login from "./pages/Login";
import SignUp from "./pages/SignUp";
import NotFound from "./pages/NotFound";

/** App pages: home, devices, profile, login, and admin. */
export default function App() {
  return (
    <AuthProvider>
      <TournamentProvider>
        <HashRouter>
          <div className="flex min-h-screen flex-col">
            <NavBar />
            <main className="pitch-lines mx-auto w-full max-w-7xl flex-1 px-6 py-10">
              {import.meta.env.VITE_STATIC_LEADERBOARD === "true" ? (
                <Routes>
                  <Route path="/" element={<Landing />} />
                  <Route path="/leaderboard" element={<Leaderboard />} />
                  <Route path="/stats" element={<Stats />} />
                  <Route path="/devices" element={<Devices />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              ) : (
                <Routes>
                  <Route path="/" element={<Landing />} />
                  <Route path="/leaderboard" element={<Leaderboard />} />
                  <Route path="/stats" element={<Stats />} />
                  <Route path="/devices" element={<Devices />} />
                  <Route path="/my-profile" element={<MyProfile />} />
                  <Route path="/my-stats" element={<Navigate to="/my-profile" replace />} />
                  <Route path="/sign-up" element={<SignUp />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/admin" element={<AdminLocal />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              )}
            </main>
            <Footer />
          </div>
        </HashRouter>
      </TournamentProvider>
    </AuthProvider>
  );
}
