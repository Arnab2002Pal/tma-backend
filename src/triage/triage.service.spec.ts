import { Test, TestingModule } from '@nestjs/testing';
import { TriageService } from './triage.service';

describe('TriageService', () => {
  let service: TriageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TriageService],
    }).compile();

    service = module.get<TriageService>(TriageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
