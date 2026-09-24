export const logger = {
  info: (message: string) => console.log(`[INFO] ${new Date().toISOString()}: ${message}`),
  // The optional error is only passed through when given - otherwise console.error would print a
  // trailing "undefined" after the message.
  error: (message: string, error?: any) => {
    const line = `[ERROR] ${new Date().toISOString()}: ${message}`;
    if (error === undefined) console.error(line);
    else console.error(line, error);
  },
  warn: (message: string) => console.warn(`[WARN] ${new Date().toISOString()}: ${message}`),
};
