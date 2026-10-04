import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { EnvVars } from '../../config/env.validation';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import {
  FakeGoogleVerifier,
  GOOGLE_VERIFIER,
  GoogleAuthLibraryVerifier,
  GoogleIdTokenVerifier,
} from './google-verifier';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    {
      provide: GOOGLE_VERIFIER,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvVars, true>,
      ): GoogleIdTokenVerifier =>
        config.get('AUTH_ALLOW_FAKE_GOOGLE', { infer: true })
          ? new FakeGoogleVerifier()
          : new GoogleAuthLibraryVerifier(
              config.get('GOOGLE_CLIENT_ID', { infer: true }),
            ),
    },
  ],
  exports: [AuthGuard, AuthService, JwtModule],
})
export class AuthModule {}
