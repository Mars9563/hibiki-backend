import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase.js';

// Extend Express Request type (if not done elsewhere)
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userJWT?: string
    }
  }
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // 1️⃣ Extract Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // 2️⃣ Validate Bearer format
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Invalid authorization format' });
    }

    // 3️⃣ Extract token
    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ message: 'Token missing' });
    }

    // 4️⃣ Verify token with Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    // 5️⃣ Attach verified identity
    req.userId = data.user.id;
    req.userJWT = token;

    // 6️⃣ Continue request lifecycle
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Authentication failed' });
  }
}

export default authMiddleware;
