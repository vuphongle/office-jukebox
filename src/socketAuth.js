export function refreshSocketIdentity(socket, sessionRepo) {
  const session = socket.sessionToken ? sessionRepo.findValid(socket.sessionToken) : null;
  socket.userId = session?.user_id || null;
  socket.isAdmin = session?.role === "admin";
  return session;
}

export function canUseHostControls(socket, session) {
  return socket.hostAuthenticated === true || session?.role === "admin";
}
