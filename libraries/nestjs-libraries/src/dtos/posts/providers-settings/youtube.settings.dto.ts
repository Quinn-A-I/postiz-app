import {
  IsArray,
  IsDefined,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { MediaDto } from '@gitroom/nestjs-libraries/dtos/media/media.dto';
import { Type } from 'class-transformer';

// YouTube caps the combined length of all tags at 500 characters.
// Tags containing whitespace are wrapped in quotes by YouTube, which adds
// two extra characters per tag toward that limit.
export const YOUTUBE_TAGS_MAX_LENGTH = 500;

export function getYoutubeTagsLength(tags: YoutubeTagsSettings[]): number {
  return (tags ?? []).reduce((total, tag) => {
    const label = tag?.label ?? '';
    return total + label.length + (/\s/.test(label) ? 2 : 0);
  }, 0);
}

@ValidatorConstraint({ name: 'IsYoutubeTagsLength', async: false })
export class IsYoutubeTagsLengthConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, _args: ValidationArguments): boolean {
    if (!Array.isArray(value)) {
      return true;
    }
    return getYoutubeTagsLength(value) <= YOUTUBE_TAGS_MAX_LENGTH;
  }

  defaultMessage(_args: ValidationArguments): string {
    return `The maximum allowed is ${YOUTUBE_TAGS_MAX_LENGTH} characters in total for all tags.`;
  }
}

export function IsYoutubeTagsLength(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsYoutubeTagsLengthConstraint,
    });
  };
}

// BCP-47 language tags as YouTube expects them for snippet.defaultLanguage
// and snippet.defaultAudioLanguage, e.g. "en", "pt-BR", "zh-Hans".
export const YOUTUBE_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i;

export class YoutubeTagsSettings {
  @IsString()
  value: string;

  @IsString()
  label: string;
}

export class YoutubeSettingsDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsDefined()
  title: string;

  @IsIn(['public', 'private', 'unlisted'])
  @IsDefined()
  type: string;

  @IsIn(['yes', 'no'])
  @IsOptional()
  selfDeclaredMadeForKids: 'no' | 'yes';

  // YouTube's "altered or synthetic content" disclosure
  // (status.containsSyntheticMedia). Only sent when set.
  @IsIn(['yes', 'no'])
  @IsOptional()
  containsSyntheticMedia?: 'no' | 'yes';

  // Language of the title and description (snippet.defaultLanguage).
  @ValidateIf((o) => !!o.defaultLanguage)
  @IsString()
  @Matches(YOUTUBE_LANGUAGE_PATTERN, {
    message: 'defaultLanguage must be a language code such as en or pt-BR',
  })
  defaultLanguage?: string;

  // Language spoken in the video (snippet.defaultAudioLanguage).
  @ValidateIf((o) => !!o.defaultAudioLanguage)
  @IsString()
  @Matches(YOUTUBE_LANGUAGE_PATTERN, {
    message: 'defaultAudioLanguage must be a language code such as en or pt-BR',
  })
  defaultAudioLanguage?: string;

  // Release time on YouTube's side (status.publishAt, ISO 8601). YouTube
  // accepts it for private uploads only and makes the video public at that
  // time - the upload and its processing can happen well before the release.
  @ValidateIf((o) => !!o.publishAt)
  @IsISO8601()
  publishAt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MediaDto)
  thumbnail?: MediaDto;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @IsYoutubeTagsLength()
  @Type(() => YoutubeTagsSettings)
  tags: YoutubeTagsSettings[];
}
