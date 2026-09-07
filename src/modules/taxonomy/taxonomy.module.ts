import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaxonomySchema, TaxonomyTerm } from './schemas/taxonomy.schema';
import { TaxonomyService } from './taxonomy.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: TaxonomyTerm.name, schema: TaxonomySchema }])],
  providers: [TaxonomyService],
  exports: [TaxonomyService, MongooseModule],
})
export class TaxonomyModule {}
