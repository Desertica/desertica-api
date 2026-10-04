import { HttpStatus, ParseIntPipe, ParseUUIDPipe } from '@nestjs/common';

/** Un id mal formado es un error de validación (422), igual que el resto de entradas. */
export class UuidPipe extends ParseUUIDPipe {
  constructor() {
    super({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });
  }
}

export class IntIdPipe extends ParseIntPipe {
  constructor() {
    super({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY });
  }
}
