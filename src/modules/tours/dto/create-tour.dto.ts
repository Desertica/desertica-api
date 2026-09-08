import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTourDto {
  @ApiProperty({ example: 'dunas-al-atardecer' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be kebab-case',
  })
  slug: string;

  @ApiProperty({ example: 'Dunas al atardecer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @ApiPropertyOptional({
    example: 'Recorrido por las dunas con parada al atardecer.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 85000, description: 'Precio en centavos' })
  @IsInt()
  @Min(0)
  priceCents: number;

  @ApiPropertyOptional({ example: 'MXN' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(1)
  durationHours: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}
