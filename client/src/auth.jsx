import { createContext, useContext, useEffect, useState } from 'react';
import { api, setSession } from './api';
import { clearOfflineData } from './offline';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading

  useEffect(() => {
    api.get('/auth/me')
      .then((nextUser) => {
        setSession(true);
        setUser(nextUser);
      })
      .catch(() => {
        setSession(false);
        setUser(null);
      });
  }, []);

  const login = async (email, password) => {
    const { user } = await api.post('/auth/login', { email, password });
    setSession(true);
    setUser(user);
    return user;
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* clear local state even if offline */ }
    setSession(false);
    await clearOfflineData();
    setUser(null);
    window.location.href = '/login';
  };

  const changePassword = async (currentPassword, newPassword) => {
    const { user: nextUser } = await api.post('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword
    });
    setUser(nextUser);
    return nextUser;
  };

  return <AuthContext.Provider value={{ user, login, logout, changePassword }}>{children}</AuthContext.Provider>;
}
