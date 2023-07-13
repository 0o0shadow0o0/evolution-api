import { InstanceDto } from '../dto/instance.dto';
import path from 'path';
import { ChatwootDto } from '../dto/chatwoot.dto';
import { WAMonitoringService } from './monitor.service';
import { Logger } from '../../config/logger.config';
import ChatwootClient from '@figuro/chatwoot-sdk';
import { createReadStream, readFileSync, unlinkSync, writeFileSync } from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { SendTextDto } from '../dto/sendMessage.dto';
import mimeTypes from 'mime-types';
import { SendAudioDto } from '../dto/sendMessage.dto';
import { SendMediaDto } from '../dto/sendMessage.dto';
import { ROOT_DIR } from '../../config/path.config';

export class ChatwootService {
  private messageCacheFile: string;
  private messageCache: Set<string>;

  private readonly logger = new Logger(ChatwootService.name);

  private provider: any;

  constructor(private readonly waMonitor: WAMonitoringService) {
    this.messageCache = new Set();
  }

  private loadMessageCache(): Set<string> {
    try {
      const cacheData = readFileSync(this.messageCacheFile, 'utf-8');
      const cacheArray = cacheData.split('\n');
      return new Set(cacheArray);
    } catch (error) {
      return new Set();
    }
  }

  private saveMessageCache() {
    const cacheData = Array.from(this.messageCache).join('\n');
    writeFileSync(this.messageCacheFile, cacheData, 'utf-8');
  }

  private async getProvider(instance: InstanceDto) {
    try {
      const provider = await this.waMonitor.waInstances[
        instance.instanceName
      ].findChatwoot();

      if (!provider) {
        return null;
      }

      return provider;
    } catch (error) {
      return null;
    }
  }

  private async clientCw(instance: InstanceDto) {
    const provider = await this.getProvider(instance);

    if (!provider) {
      this.logger.error('provider not found');
      return null;
    }

    this.provider = provider;

    const client = new ChatwootClient({
      config: {
        basePath: provider.url,
        with_credentials: true,
        credentials: 'include',
        token: provider.token,
      },
    });

    return client;
  }

  public create(instance: InstanceDto, data: ChatwootDto) {
    this.logger.verbose('create chatwoot: ' + instance.instanceName);
    this.waMonitor.waInstances[instance.instanceName].setChatwoot(data);

    return data;
  }

  public async find(instance: InstanceDto): Promise<ChatwootDto> {
    try {
      this.logger.verbose('find chatwoot: ' + instance.instanceName);
      return await this.waMonitor.waInstances[instance.instanceName].findChatwoot();
    } catch (error) {
      return { enabled: null, url: '' };
    }
  }

  public async getContact(instance: InstanceDto, id: number) {
    const client = await this.clientCw(instance);

    if (!client) {
      throw new Error('client not found');
    }

    if (!id) {
      throw new Error('id is required');
    }

    const contact = await client.contact.getContactable({
      accountId: this.provider.account_id,
      id,
    });

    if (!contact) {
      return null;
    }

    return contact;
  }

  public async initInstanceChatwoot(
    instance: InstanceDto,
    inboxName: string,
    webhookUrl: string,
    qrcode: boolean,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      throw new Error('client not found');
    }

    const findInbox: any = await client.inboxes.list({
      accountId: this.provider.account_id,
    });

    const checkDuplicate = findInbox.payload
      .map((inbox) => inbox.name)
      .includes(inboxName);

    let inboxId: number;

    if (!checkDuplicate) {
      const data = {
        type: 'api',
        webhook_url: webhookUrl,
      };

      const inbox = await client.inboxes.create({
        accountId: this.provider.account_id,
        data: {
          name: inboxName,
          channel: data as any,
        },
      });

      if (!inbox) {
        return null;
      }

      inboxId = inbox.id;
    } else {
      const inbox = findInbox.payload.find((inbox) => inbox.name === inboxName);

      inboxId = inbox.id;
    }

    const contact =
      (await this.findContact(instance, '123456')) ||
      ((await this.createContact(
        instance,
        '123456',
        inboxId,
        false,
        'EvolutionAPI',
      )) as any);

    const contactId = contact.id || contact.payload.contact.id;

    if (qrcode) {
      const conversation = await client.conversations.create({
        accountId: this.provider.account_id,
        data: {
          contact_id: contactId.toString(),
          inbox_id: inboxId.toString(),
        },
      });

      await client.messages.create({
        accountId: this.provider.account_id,
        conversationId: conversation.id,
        data: {
          content: '/iniciar',
          message_type: 'outgoing',
        },
      });
    }

    return true;
  }

  public async createContact(
    instance: InstanceDto,
    phoneNumber: string,
    inboxId: number,
    isGroup: boolean,
    name?: string,
  ) {
    const client = await this.clientCw(instance);

    if (!client) {
      throw new Error('client not found');
    }

    let data: any = {};
    if (!isGroup) {
      data = {
        inbox_id: inboxId,
        name: name || phoneNumber,
        phone_number: `+${phoneNumber}`,
      };
    } else {
      data = {
        inbox_id: inboxId,
        name: name || phoneNumber,
        identifier: phoneNumber,
      };
    }
    const contact = await client.contacts.create({
      accountId: this.provider.account_id,
      data,
    });

    if (!contact) {
      return null;
    }

    return contact;
  }

  public async updateContact(instance: InstanceDto, id: number, data: any) {
    const client = await this.clientCw(instance);

    if (!client) {
      throw new Error('client not found');
    }

    if (!id) {
      throw new Error('id is required');
    }

    const contact = await client.contacts.update({
      accountId: this.provider.account_id,
      id,
      data,
    });

    return contact;
  }

  public async findContact(instance: InstanceDto, phoneNumber: string) {
    const client = await this.clientCw(instance);

    if (!client) {
      throw new Error('client not found');
    }

    let query: any;

    if (!phoneNumber.includes('@g.us')) {
      query = `+${phoneNumber}`;
    } else {
      query = phoneNumber;
    }

    const contact: any = await client.contacts.search({
      accountId: this.provider.account_id,
      q: query,
    });

    if (!phoneNumber.includes('@g.us')) {
      return contact.payload.find((contact) => contact.phone_number === query);
    } else {
      return contact.payload.find((contact) => contact.identifier === query);
    }
  }

  public async createConversation(instance: InstanceDto, body: any) {
    try {
      const client = await this.clientCw(instance);

      if (!client) {
        throw new Error('client not found');
      }

      const isGroup = body.key.remoteJid.includes('@g.us');

      const chatId = isGroup ? body.key.remoteJid : body.key.remoteJid.split('@')[0];

      let nameContact: string;

      nameContact = !body.key.fromMe ? body.pushName : chatId;

      const filterInbox = await this.getInbox(instance);

      if (isGroup) {
        const group = await this.waMonitor.waInstances[
          instance.instanceName
        ].client.groupMetadata(chatId);

        nameContact = `${group.subject} (GROUP)`;

        const participant =
          (await this.findContact(instance, body.key.participant.split('@')[0])) ||
          ((await this.createContact(
            instance,
            body.key.participant.split('@')[0],
            filterInbox.id,
            false,
            body.pushName || body.key.participant.split('@')[0],
          )) as any);
      }

      const contact =
        (await this.findContact(instance, chatId)) ||
        ((await this.createContact(
          instance,
          chatId,
          filterInbox.id,
          isGroup,
          nameContact,
        )) as any);

      const contactId = contact.id || contact.payload.contact.id;

      if (!body.key.fromMe && contact.name === chatId && nameContact !== chatId) {
        await this.updateContact(instance, contactId, {
          name: nameContact,
        });
      }

      const contactConversations = (await client.contacts.listConversations({
        accountId: this.provider.account_id,
        id: contactId,
      })) as any;

      if (contactConversations) {
        const conversation = contactConversations.payload.find(
          (conversation) =>
            conversation.status !== 'resolved' && conversation.inbox_id == filterInbox.id,
        );
        if (conversation) {
          return conversation.id;
        }
      }

      const conversation = await client.conversations.create({
        accountId: this.provider.account_id,
        data: {
          contact_id: `${contactId}`,
          inbox_id: `${filterInbox.id}`,
        },
      });

      return conversation.id;
    } catch (error) {
      console.log(error);
    }
  }

  public async getInbox(instance: InstanceDto) {
    const client = await this.clientCw(instance);

    if (!client) {
      throw new Error('client not found');
    }

    const inbox = (await client.inboxes.list({
      accountId: this.provider.account_id,
    })) as any;

    const findByName = inbox.payload.find(
      (inbox) => inbox.name === instance.instanceName,
    );
    return findByName;
  }

  public async createMessage(
    instance: InstanceDto,
    conversationId: number,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
  ) {
    const client = await this.clientCw(instance);

    const message = await client.messages.create({
      accountId: this.provider.account_id,
      conversationId: conversationId,
      data: {
        content: content,
        message_type: messageType,
        attachments: attachments,
      },
    });

    return message;
  }

  public async createBotMessage(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    attachments?: {
      content: unknown;
      encoding: string;
      filename: string;
    }[],
  ) {
    const client = await this.clientCw(instance);

    const contact = await this.findContact(instance, '123456');

    const filterInbox = await this.getInbox(instance);

    const findConversation = await client.conversations.list({
      accountId: this.provider.account_id,
      inboxId: filterInbox.id,
    });

    const conversation = findConversation.data.payload.find(
      (conversation) =>
        conversation?.meta?.sender?.id === contact.id && conversation.status === 'open',
    );

    const message = await client.messages.create({
      accountId: this.provider.account_id,
      conversationId: conversation.id,
      data: {
        content: content,
        message_type: messageType,
        attachments: attachments,
      },
    });

    return message;
  }

  private async sendData(
    conversationId: number,
    file: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    content?: string,
  ) {
    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    data.append('attachments[]', createReadStream(file));

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${this.provider.url}/api/v1/accounts/${this.provider.account_id}/conversations/${conversationId}/messages`,
      headers: {
        api_access_token: this.provider.token,
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);
      unlinkSync(file);
      return data;
    } catch (error) {
      console.log(error);
    }
  }

  public async createBotQr(
    instance: InstanceDto,
    content: string,
    messageType: 'incoming' | 'outgoing' | undefined,
    file?: string,
  ) {
    const client = await this.clientCw(instance);

    const contact = await this.findContact(instance, '123456');

    const filterInbox = await this.getInbox(instance);

    const findConversation = await client.conversations.list({
      accountId: this.provider.account_id,
      inboxId: filterInbox.id,
    });
    const conversation = findConversation.data.payload.find(
      (conversation) =>
        conversation?.meta?.sender?.id === contact.id && conversation.status === 'open',
    );

    const data = new FormData();

    if (content) {
      data.append('content', content);
    }

    data.append('message_type', messageType);

    if (file) {
      data.append('attachments[]', createReadStream(file));
    }

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${this.provider.url}/api/v1/accounts/${this.provider.account_id}/conversations/${conversation.id}/messages`,
      headers: {
        api_access_token: this.provider.token,
        ...data.getHeaders(),
      },
      data: data,
    };

    try {
      const { data } = await axios.request(config);
      unlinkSync(file);
      return data;
    } catch (error) {
      console.log(error);
    }
  }

  public async sendAttachment(
    waInstance: any,
    number: string,
    media: any,
    caption?: string,
  ) {
    try {
      const parts = media.split('/');
      const fileName = decodeURIComponent(parts[parts.length - 1]);

      const mimeType = mimeTypes.lookup(fileName).toString();

      let type = 'document';

      switch (mimeType.split('/')[0]) {
        case 'image':
          type = 'image';
          break;
        case 'video':
          type = 'video';
          break;
        case 'audio':
          type = 'audio';
          break;
        default:
          type = 'document';
          break;
      }

      if (type === 'audio') {
        const data: SendAudioDto = {
          number: number,
          audioMessage: {
            audio: media,
          },
          options: {
            delay: 1200,
            presence: 'recording',
          },
        };

        await waInstance?.audioWhatsapp(data);

        return;
      }

      const data: SendMediaDto = {
        number: number,
        mediaMessage: {
          mediatype: type as any,
          fileName: fileName,
          media: media,
        },
        options: {
          delay: 1200,
          presence: 'composing',
        },
      };

      if (caption && type !== 'audio') {
        data.mediaMessage.caption = caption;
      }

      await waInstance?.mediaMessage(data);

      return;
    } catch (error) {
      throw new Error(error);
    }
  }

  public async receiveWebhook(instance: InstanceDto, body: any) {
    try {
      const client = await this.clientCw(instance);

      if (!body?.conversation || body.private) return { message: 'bot' };

      const chatId =
        body.conversation.meta.sender?.phone_number?.replace('+', '') ||
        body.conversation.meta.sender?.identifier;
      const messageReceived = body.content;
      const senderName = body?.sender?.name;
      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      if (chatId === '123456' && body.message_type === 'outgoing') {
        const command = messageReceived.replace('/', '');

        if (command === 'iniciar') {
          const state = waInstance?.connectionStatus?.state;

          if (state !== 'open') {
            await waInstance.connectToWhatsapp();
          } else {
            await this.createBotMessage(
              instance,
              `🚨 Instância ${body.inbox.name} já está conectada.`,
              'incoming',
            );
          }
        }

        if (command === 'status') {
          const state = waInstance?.connectionStatus?.state;

          if (!state) {
            await this.createBotMessage(
              instance,
              `⚠️ Instância ${body.inbox.name} não existe.`,
              'incoming',
            );
          }

          if (state) {
            await this.createBotMessage(
              instance,
              `⚠️ Status da instância ${body.inbox.name}: *${state}*`,
              'incoming',
            );
          }
        }

        if (command === 'desconectar') {
          const msgLogout = `🚨 Desconectando Whatsapp da caixa de entrada *${body.inbox.name}*: `;

          await this.createBotMessage(instance, msgLogout, 'incoming');
          await waInstance?.client?.logout('Log out instance: ' + instance.instanceName);
          await waInstance?.client?.ws?.close();
        }
      }

      if (
        body.message_type === 'outgoing' &&
        body?.conversation?.messages?.length &&
        chatId !== '123456'
      ) {
        this.messageCacheFile = path.join(
          ROOT_DIR,
          'store',
          'chatwoot',
          `${instance.instanceName}_cache.txt`,
        );

        this.messageCache = this.loadMessageCache();

        if (this.messageCache.has(body.id.toString())) {
          return { message: 'bot' };
        }

        let formatText: string;
        if (senderName === null || senderName === undefined) {
          formatText = messageReceived;
        } else {
          formatText = this.provider.sign_msg
            ? `*${senderName}:*\n\n${messageReceived}`
            : messageReceived;
        }

        for (const message of body.conversation.messages) {
          if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
              if (!messageReceived) {
                formatText = null;
              }

              await this.sendAttachment(
                waInstance,
                chatId,
                attachment.data_url,
                formatText,
              );
            }
          } else {
            const data: SendTextDto = {
              number: chatId,
              textMessage: {
                text: formatText,
              },
              options: {
                delay: 1200,
                presence: 'composing',
              },
            };

            await waInstance?.textMessage(data);
          }
        }
      }

      if (body.message_type === 'template' && body.content_type === 'input_csat') {
        const data: SendTextDto = {
          number: chatId,
          textMessage: {
            text: body.content,
          },
          options: {
            delay: 1200,
            presence: 'composing',
          },
        };

        await waInstance?.textMessage(data);
      }

      return { message: 'bot' };
    } catch (error) {
      console.log(error);

      return { message: 'bot' };
    }
  }

  private isMediaMessage(message: any) {
    const media = [
      'imageMessage',
      'documentMessage',
      'documentWithCaptionMessage',
      'audioMessage',
      'videoMessage',
      'stickerMessage',
    ];

    const messageKeys = Object.keys(message);
    return messageKeys.some((key) => media.includes(key));
  }

  private getTypeMessage(msg: any) {
    const types = {
      conversation: msg.conversation,
      imageMessage: msg.imageMessage?.caption,
      videoMessage: msg.videoMessage?.caption,
      extendedTextMessage: msg.extendedTextMessage?.text,
      messageContextInfo: msg.messageContextInfo?.stanzaId,
      stickerMessage: msg.stickerMessage?.fileSha256.toString('base64'),
      documentMessage: msg.documentMessage?.caption,
      documentWithCaptionMessage:
        msg.documentWithCaptionMessage?.message?.documentMessage?.caption,
      audioMessage: msg.audioMessage?.caption,
    };

    return types;
  }

  private getMessageContent(types: any) {
    const typeKey = Object.keys(types).find((key) => types[key] !== undefined);
    return typeKey ? types[typeKey] : undefined;
  }

  private getConversationMessage(msg: any) {
    const types = this.getTypeMessage(msg);

    const messageContent = this.getMessageContent(types);

    return messageContent;
  }

  public async eventWhatsapp(event: string, instance: InstanceDto, body: any) {
    try {
      const client = await this.clientCw(instance);

      if (!client) {
        throw new Error('client not found');
      }

      const waInstance = this.waMonitor.waInstances[instance.instanceName];

      if (event === 'messages.upsert') {
        if (body.key.remoteJid === 'status@broadcast') {
          return;
        }

        const getConversion = await this.createConversation(instance, body);
        const messageType = body.key.fromMe ? 'outgoing' : 'incoming';

        if (!getConversion) {
          return;
        }

        const isMedia = this.isMediaMessage(body.message);

        const bodyMessage = await this.getConversationMessage(body.message);

        if (!bodyMessage) {
          return;
        }

        if (isMedia) {
          const downloadBase64 = await waInstance?.getBase64FromMediaMessage({
            message: {
              ...body,
            },
          });

          const random = Math.random().toString(36).substring(7);
          const nameFile = `${random}.${mimeTypes.extension(downloadBase64.mimetype)}`;

          const fileData = Buffer.from(downloadBase64.base64, 'base64');

          const fileName = `${path.join(
            waInstance?.storePath,
            'chatwoot',
            `${nameFile}`,
          )}`;

          writeFileSync(fileName, fileData, 'utf8');

          if (body.key.remoteJid.includes('@g.us') && !body.key.fromMe) {
            const participantName = body.pushName;

            const content = `**${participantName}**\n\n${bodyMessage}`;
            return await this.sendData(getConversion, fileName, messageType, content);
          } else {
            return await this.sendData(getConversion, fileName, messageType, bodyMessage);
          }
        }

        if (body.key.remoteJid.includes('@g.us')) {
          const participantName = body.pushName;

          const content = `**${participantName}**\n\n${bodyMessage}`;

          const send = await this.createMessage(
            instance,
            getConversion,
            content,
            messageType,
          );

          this.messageCacheFile = path.join(
            ROOT_DIR,
            'store',
            'chatwoot',
            `${instance.instanceName}_cache.txt`,
          );

          this.messageCache = this.loadMessageCache();

          this.messageCache.add(send.id.toString());

          this.saveMessageCache();

          return send;
        } else {
          const send = await this.createMessage(
            instance,
            getConversion,
            bodyMessage,
            messageType,
          );

          this.messageCacheFile = path.join(
            ROOT_DIR,
            'store',
            'chatwoot',
            `${instance.instanceName}_cache.txt`,
          );

          this.messageCache = this.loadMessageCache();

          this.messageCache.add(send.id.toString());

          this.saveMessageCache();

          return send;
        }
      }

      if (event === 'status.instance') {
        const data = body;
        const inbox = await this.getInbox(instance);

        if (!inbox) {
          return;
        }

        const msgStatus = `⚡️ Status da instância ${inbox.name}: ${data.status}`;
        await this.createBotMessage(instance, msgStatus, 'incoming');
      }

      if (event === 'connection.update') {
        if (body.state === 'open') {
          const msgConnection = `🚀 Conexão realizada com sucesso!`;
          await this.createBotMessage(instance, msgConnection, 'incoming');
        }
      }

      if (event === 'contacts.update') {
        const data = body;

        if (data.length) {
          for (const item of data) {
            const number = item.id.split('@')[0];
            const photo = item.profilePictureUrl || null;
            const find = await this.findContact(instance, number);

            if (find) {
              await this.updateContact(instance, find.id, {
                avatar_url: photo,
              });
            }
          }
        }
      }

      if (event === 'qrcode.updated') {
        if (body.statusCode === 500) {
          const erroQRcode = `🚨 Limite de geração de QRCode atingido, para gerar um novo QRCode, envie a mensagem /iniciar novamente.`;
          return await this.createBotMessage(instance, erroQRcode, 'incoming');
        } else {
          const fileData = Buffer.from(
            body?.qrcode.base64.replace('data:image/png;base64,', ''),
            'base64',
          );

          const fileName = `${path.join(
            waInstance?.storePath,
            'temp',
            `${`${instance}.png`}`,
          )}`;

          writeFileSync(fileName, fileData, 'utf8');

          await this.createBotQr(
            instance,
            'QRCode gerado com sucesso!',
            'incoming',
            fileName,
          );

          const msgQrCode = `⚡️ QRCode gerado com sucesso!\n\nDigitalize este código QR nos próximos 40 segundos:`;
          await this.createBotMessage(instance, msgQrCode, 'incoming');
        }
      }
    } catch (error) {
      console.log(error);
    }
  }
}
