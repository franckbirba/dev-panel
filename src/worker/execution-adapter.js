export class ExecutionAdapter {
  capabilities() {
    throw new Error(`${this.constructor.name}.capabilities() is not implemented`);
  }

  start() {
    throw new Error(`${this.constructor.name}.start() is not implemented`);
  }

  resume() {
    throw new Error(`${this.constructor.name}.resume() is not implemented`);
  }

  cancel() {
    throw new Error(`${this.constructor.name}.cancel() is not implemented`);
  }

  export() {
    throw new Error(`${this.constructor.name}.export() is not implemented`);
  }
}
