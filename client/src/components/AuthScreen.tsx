import { useState } from "react";
import type { AppUser } from "../types/models";
import { api } from "../utils/api";

type AuthScreenProps = {
  onAuthenticated: (user: AppUser) => Promise<void>;
};

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [registerForm, setRegisterForm] = useState({ name: "", email: "", password: "" });
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await api.registerOwner(registerForm);
      await onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to register owner");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await api.login(loginForm);
      await onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <section className="panel auth-panel">
        <div>
          <p className="eyebrow">Welcome</p>
          <h1>Dream Home Construction App</h1>
          <p className="muted">Sign in to continue, or create the owner account if this is your first setup.</p>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="auth-grid">
          <form className="stack-sm" onSubmit={handleRegister}>
            <h3>Create Owner Account</h3>
            <label>
              Name
              <input
                required
                value={registerForm.name}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <label>
              Email
              <input
                required
                type="email"
                value={registerForm.email}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, email: event.target.value }))}
              />
            </label>
            <label>
              Password
              <input
                required
                type="password"
                value={registerForm.password}
                onChange={(event) => setRegisterForm((prev) => ({ ...prev, password: event.target.value }))}
              />
            </label>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Please wait..." : "Create Owner"}
            </button>
          </form>

          <form className="stack-sm" onSubmit={handleLogin}>
            <h3>Login</h3>
            <label>
              Email
              <input
                required
                type="email"
                value={loginForm.email}
                onChange={(event) => setLoginForm((prev) => ({ ...prev, email: event.target.value }))}
              />
            </label>
            <label>
              Password
              <input
                required
                type="password"
                value={loginForm.password}
                onChange={(event) => setLoginForm((prev) => ({ ...prev, password: event.target.value }))}
              />
            </label>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Please wait..." : "Login"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}