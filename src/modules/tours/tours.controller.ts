import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateTourDto } from './dto/create-tour.dto';
import { UpdateTourDto } from './dto/update-tour.dto';
import { ToursService } from './tours.service';

@ApiTags('tours')
@Controller('tours')
export class ToursController {
  constructor(private readonly toursService: ToursService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un tour' })
  create(@Body() dto: CreateTourDto) {
    return this.toursService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar tours' })
  findAll() {
    return this.toursService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un tour por id' })
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.toursService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar un tour' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateTourDto,
  ) {
    return this.toursService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un tour' })
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.toursService.remove(id);
  }
}
