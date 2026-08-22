import { Module } from '@nestjs/common';
import { PerfController } from './perf.controller';

@Module({ controllers: [PerfController] })
export class PerfModule {}
