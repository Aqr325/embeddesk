import * as db from './server/db.js';
import { verifyPassword } from './server/auth.js';
const u = db.getUserByUsername('admin');
console.log('user exists:', !!u, 'status:', u && u.status);
if (u) {
  console.log('verify testadmin:', verifyPassword('testadmin', u.password_hash));
  console.log('verify wrongpass:', verifyPassword('wrongpass', u.password_hash));
}
