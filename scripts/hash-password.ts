/** Prints the APP_PASSWORD_HASH value for a password:  npm run hash-password -- "your password" */
import { hashPassword } from '../src/lib/password'

const pw = process.argv[2]
if (!pw || pw.length < 10) {
  console.error('Usage: npm run hash-password -- "a password of at least 10 characters"')
  process.exit(1)
}
console.log(`APP_PASSWORD_HASH=${hashPassword(pw)}`)
