declare module "qrcode-terminal" {
  interface QRCodeTerminal {
    generate(
      input: string,
      opts?: { small?: boolean },
      cb?: (qrcode: string) => void,
    ): void;
    setErrorLevel(level: string): void;
  }
  const qrcode: QRCodeTerminal;
  export default qrcode;
}
