const parseJWT = (req) => {
  const authHeader = req.headers.authorization || null;
  let jwt = null;
  if (authHeader != null) {
    const parts = authHeader.split(' ');
    if (parts.length === 2) {
      if (parts[0].toLowerCase() === 'bearer') {
        jwt = parts[1]; // eslint-disable-line
      }
    }
  }
  if (authHeader == null) {
    const cookie = (req.headers.cookie || '').split(';')
      .map((part) => part.trim()).find((part) => part.startsWith('access_token='));
    if (cookie) {
      try { jwt = decodeURIComponent(cookie.slice('access_token='.length)); } catch (err) { return null; }
    }
  }
  return jwt;
};

export default {
  parseJWT,
};
