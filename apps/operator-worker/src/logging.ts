export interface OperatorWorkerLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const formatLine = (level: 'INFO' | 'ERROR', message: string, fields?: Readonly<Record<string, unknown>>): string => {
  return JSON.stringify({
    level,
    message,
    ...(fields === undefined ? {} : { fields }),
  });
};

export const createOperatorWorkerLogger = (stderr: NodeJS.WriteStream = process.stderr): OperatorWorkerLogger => ({
  info(message, fields) {
    stderr.write(`${formatLine('INFO', message, fields)}\n`);
  },
  error(message, fields) {
    stderr.write(`${formatLine('ERROR', message, fields)}\n`);
  },
});
