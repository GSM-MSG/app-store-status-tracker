import axios from "axios";
import dayjs from "dayjs";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";

interface AppStoreConnectResponse {
  data: {
    type: string;
    id: string;
    attributes: {
      platform: string;
      appVersionState: string;
      createdDate?: string;
      versionString: string;
      releaseType: string;
    };
    relationships?: {
      build?: {
        data?: {
          type: string;
          id: string;
        };
      };
    };
  }[];
  included?: {
    type: string;
    id: string;
    attributes: {
      version?: string;
      [key: string]: any;
    };
  }[];
  links: {
    self: string;
  };
}

interface AppStatus {
  state: string;
  createdDate?: string;
  versionString: string;
  releaseType: string;
}

interface StatusStorage {
  [appId: string]: AppStatus;
}

export interface AppConfig {
  name: string;
  appId: string;
  webhookUrl: string;
  icon: string;
}

export class AppStatusService {
  private readonly statusFilePath: string;

  constructor(private readonly apps: AppConfig[]) {
    this.statusFilePath = path.join(process.cwd(), "status.json");
    this.initializeStatusFile();
  }

  private initializeStatusFile() {
    if (!fs.existsSync(this.statusFilePath)) {
      fs.writeFileSync(this.statusFilePath, JSON.stringify({}, null, 2));
    }
  }

  private loadPreviousStatuses(): StatusStorage {
    try {
      const data = fs.readFileSync(this.statusFilePath, "utf-8");
      return JSON.parse(data);
    } catch (error) {
      console.error("상태 파일을 읽는 중 오류가 발생했습니다:", error);
      return {};
    }
  }

  private savePreviousStatus(appId: string, status: AppStatus) {
    try {
      const currentStatuses = this.loadPreviousStatuses();
      currentStatuses[appId] = status;
      fs.writeFileSync(this.statusFilePath, JSON.stringify(currentStatuses, null, 2));
    } catch (error) {
      console.error("상태 파일을 저장하는 중 오류가 발생했습니다:", error);
    }
  }

  private hasStatusChanged(appId: string, currentStatus: AppStatus): boolean {
    const previousStatuses = this.loadPreviousStatuses();
    const previousStatus = previousStatuses[appId];

    if (!previousStatus) {
      return true;
    }

    return (
      previousStatus.state !== currentStatus.state ||
      previousStatus.versionString !== currentStatus.versionString
    );
  }

  async checkAppStatus() {
    if (
      !process.env.APP_STORE_CONNECT_KEY_ID ||
      !process.env.APP_STORE_CONNECT_ISSUER_ID ||
      !process.env.APP_STORE_CONNECT_PRIVATE_KEY
    ) {
      console.error("App Store Connect API 인증 정보가 없습니다.");
      return;
    }

    for (const app of this.apps) {
      try {
        const token = await this.generateToken();
        const response = await axios.get<AppStoreConnectResponse>(
          `https://api.appstoreconnect.apple.com/v1/apps/${app.appId}/appStoreVersions?include=build`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        if (!response.data.data || response.data.data.length === 0) {
          throw new Error("앱 버전 정보를 찾을 수 없습니다.");
        }

        const filterIOS = response.data.data.filter(
          (item: any) => item.attributes.platform === "IOS"
        );
        if (filterIOS.length === 0) {
          throw new Error("iOS 앱 버전 정보를 찾을 수 없습니다.");
        }
        // TODO: iOS만이 아닌 다른 플랫폼도 지원
        const latestVersion = filterIOS[0];

        let buildNumber: string | undefined;
        if (latestVersion.relationships?.build?.data?.id && response.data.included) {
          const buildId = latestVersion.relationships.build.data.id;
          const buildInfo = response.data.included.find(
            (item) => item.type === "builds" && item.id === buildId
          );
          buildNumber = buildInfo?.attributes?.version;
        }

        const currentStatus: AppStatus = {
          state: latestVersion.attributes.appVersionState,
          createdDate: latestVersion.attributes.createdDate,
          versionString: latestVersion.attributes.versionString,
          releaseType: latestVersion.attributes.releaseType
        };

        if (this.hasStatusChanged(app.appId, currentStatus)) {
          const submittedDate = currentStatus.createdDate
            ? dayjs(currentStatus.createdDate).format("YYYY년 MM월 DD일 HH:mm")
            : "없음";

          const previousStatus = this.loadPreviousStatuses()[app.appId];
          const versionChanged =
            previousStatus && previousStatus.versionString !== currentStatus.versionString;
          const stateChanged = !previousStatus || previousStatus.state !== currentStatus.state;

          let titleText = "";

          if (versionChanged && stateChanged) {
            titleText = `${app.name} 버전과 상태가 변경되었습니다!`;
          } else if (versionChanged) {
            titleText = `${app.name} 버전이 변경되었습니다!`;
          } else {
            titleText = `${app.name} 상태가 변경되었습니다!`;
          }

          let versionString: string;

          if (
            currentStatus.state === "READY_FOR_DISTRIBUTION" ||
            currentStatus.state === "PENDING_DEVELOPER_RELEASE" ||
            currentStatus.state === "WAITING_FOR_REVIEW" ||
            currentStatus.state === "IN_REVIEW"
          ) {
            versionString = `${currentStatus.versionString} (${buildNumber})`;
          } else {
            versionString = currentStatus.versionString;
          }

          const fields = [
            {
              title: "현재 상태",
              value: `${this.getStateEmoji(currentStatus.state)} ${this.getStateMessage(
                currentStatus.state
              )}`,
              short: true
            },
            {
              title: "현재 버전",
              value: versionString,
              short: true
            },
            {
              title: "버전 출시 타입",
              value: this.getReleaseTypeMessage(currentStatus.releaseType),
              short: true
            }
          ];

          if (previousStatus && versionChanged) {
            fields.push(
              {
                title: "이전 버전",
                value: previousStatus.versionString,
                short: true
              },
              {
                title: "제출 일시",
                value: submittedDate,
                short: true
              }
            );
          } else {
            fields.push({
              title: "제출 일시",
              value: submittedDate,
              short: true
            });
          }

          const webhookPayload = {
            embeds: [
              {
                title: titleText,
                color: this.getStateColor(currentStatus.state),
                author: {
                  name: app.name,
                  icon_url: app.icon
                },
                footer: {
                  text: "App Store Connect",
                  icon_url:
                    "https://developer.apple.com/assets/elements/icons/app-store-connect/app-store-connect-64x64.png"
                },
                timestamp: new Date().toISOString(),
                url: `https://appstoreconnect.apple.com/apps/${app.appId}/appstore`,
                fields: fields.map((field) => ({
                  name: field.title,
                  value: field.value,
                  inline: field.short || false
                }))
              }
            ]
          };

          await axios.post(app.webhookUrl, webhookPayload);
        }

        this.savePreviousStatus(app.appId, currentStatus);
      } catch (error) {
        console.error(`Error checking ${app.name} status:`, error);

        let errorMessage = `❌ ${app.name} 앱 상태 확인 중 오류가 발생했습니다.`;

        if (axios.isAxiosError(error)) {
          if (error.response?.status === 401) {
            errorMessage += "\n인증 토큰이 만료되었거나 유효하지 않습니다.";
          } else if (error.response?.status === 404) {
            errorMessage += "\n앱을 찾을 수 없습니다.";
          }
        }

        console.error(error);
        /*await axios.post(app.webhookUrl, {
          content: errorMessage
        });*/
      }
    }
  }

  private async generateToken(): Promise<string> {
    const keyId = process.env.APP_STORE_CONNECT_KEY_ID!;
    const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID!;
    const privateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY!;

    const token = jwt.sign(
      {
        iss: issuerId,
        exp: Math.floor(Date.now() / 1000) + 20 * 60, // 20분 유효
        aud: "appstoreconnect-v1"
      },
      privateKey,
      {
        algorithm: "ES256",
        header: {
          alg: "ES256",
          kid: keyId,
          typ: "JWT"
        }
      }
    );

    return token;
  }

  private getStateEmoji(state: string): string {
    switch (state) {
      case "ACCEPTED":
        return "✅";
      case "DEVELOPER_REJECTED":
        return "🚫";
      case "IN_REVIEW":
        return "🔍";
      case "INVALID_BINARY":
        return "⚠️";
      case "METADATA_REJECTED":
        return "📝❌";
      case "PENDING_APPLE_RELEASE":
        return "⏳";
      case "PENDING_DEVELOPER_RELEASE":
        return "👨‍💻";
      case "PREPARE_FOR_SUBMISSION":
        return "📦";
      case "PROCESSING_FOR_DISTRIBUTION":
        return "⚙️";
      case "READY_FOR_DISTRIBUTION":
        return "🎉";
      case "READY_FOR_REVIEW":
        return "📤";
      case "REJECTED":
        return "❌";
      case "REPLACED_WITH_NEW_VERSION":
        return "🔄";
      case "WAITING_FOR_EXPORT_COMPLIANCE":
        return "📋";
      case "WAITING_FOR_REVIEW":
        return "⏳";
      default:
        return "❓";
    }
  }

  private getStateMessage(state: string): string {
    switch (state) {
      case "ACCEPTED":
        return "심사 승인";
      case "DEVELOPER_REJECTED":
        return "개발자에 의한 심사 취소";
      case "IN_REVIEW":
        return "심사 진행 중";
      case "INVALID_BINARY":
        return "바이너리 무효";
      case "METADATA_REJECTED":
        return "메타데이터 거절";
      case "PENDING_APPLE_RELEASE":
        return "애플 출시 대기 중";
      case "PENDING_DEVELOPER_RELEASE":
        return "심사 승인, 출시 대기 중";
      case "PREPARE_FOR_SUBMISSION":
        return "제출 준비 중";
      case "PROCESSING_FOR_DISTRIBUTION":
        return "배포 처리 중";
      case "READY_FOR_DISTRIBUTION":
        return "배포 완료";
      case "READY_FOR_REVIEW":
        return "심사 준비 완료";
      case "REJECTED":
        return "심사 거절";
      case "REPLACED_WITH_NEW_VERSION":
        return "새 버전으로 대체됨";
      case "WAITING_FOR_EXPORT_COMPLIANCE":
        return "수출 규정 검토 대기 중";
      case "WAITING_FOR_REVIEW":
        return "심사 대기 중";
      default:
        return "알 수 없는 상태";
    }
  }

  private getStateColor(state: string): number {
    switch (state) {
      case "ACCEPTED":
      case "READY_FOR_DISTRIBUTION":
        return 0x36a64f; // 초록색
      case "DEVELOPER_REJECTED":
      case "REJECTED":
      case "INVALID_BINARY":
      case "METADATA_REJECTED":
        return 0xdc3545; // 빨간색
      case "IN_REVIEW":
      case "WAITING_FOR_REVIEW":
      case "WAITING_FOR_EXPORT_COMPLIANCE":
        return 0xffc107; // 노란색
      case "PENDING_APPLE_RELEASE":
      case "PENDING_DEVELOPER_RELEASE":
      case "PROCESSING_FOR_DISTRIBUTION":
        return 0x0088cc; // 파란색
      case "PREPARE_FOR_SUBMISSION":
      case "READY_FOR_REVIEW":
      case "REPLACED_WITH_NEW_VERSION":
        return 0x6f42c1; // 보라색
      default:
        return 0x95a5a6; // 회색
    }
  }

  private getReleaseTypeMessage(releaseType: string): string {
    switch (releaseType) {
      case "MANUAL":
        return "📤 수동 배포";
      case "AFTER_APPROVAL":
        return "🚀 승인 후 자동 배포";
      case "SCHEDULED":
        return "⏰ 예약 배포";
      default:
        return `${releaseType} 배포`;
    }
  }
}
