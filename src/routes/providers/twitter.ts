import { config } from '../../config';
import express from 'express';
import { Issuer, generators, TokenSet } from 'openid-client';
import axios from 'axios';
import { getSessionToken } from './../../library';
const db = {}; // TODO: use prisma hasura etc

const router = express.Router();
interface UsersMeResponse {
  data: {
    id: string;
    name: string;
    username: string;
  };
}

interface RevocationResponse {
  revoked: boolean;
}
declare module 'express-session' {
  export interface SessionData {
    token_set: TokenSet;
    state: string;
    codeVerifier: string;
    originalUrl: string;
    redirect_uri: string;
  }
}

let issuer;
let confidentialClient;
let publicClient;
let client;

const getTwiiterSessionToken = async (token_set) => {
  const { data } = await axios.get<UsersMeResponse>('https://api.twitter.com/2/users/me', {
    headers: {
      Authorization: `Bearer ${token_set.access_token}`,
    },
  });
  const token = getSessionToken({
    user: {
      ...data.data,
    },
    token_set,
  });
  return token;
};

if (config.providers.twitter) {
  issuer = new Issuer({
    issuer: 'https://twitter.com',
    authorization_endpoint: 'https://twitter.com/i/oauth2/authorize',
    token_endpoint: 'https://api.twitter.com/2/oauth2/token',
  });

  confidentialClient = new issuer.Client({
    client_id: config.providers.twitter.client_id,
    client_secret: config.providers.twitter.consumer_secret,
  });

  publicClient = new issuer.Client({
    client_id: config.providers.twitter.client_id,
    token_endpoint_auth_method: 'none',
  });

  client = config.providers.twitter.client_type == 'PUBLIC' ? publicClient : confidentialClient;

  router.get('/provider/twitter', (req, res, next) => {
    (async () => {
      const redirect_uri = (req.query.redirect_uri as string) || req.originalUrl;
      if (req.session.token_set) {
        const token = await getTwiiterSessionToken(req.session.token_set);
        const client_redirect_uri = `${redirect_uri}?token=${token}&provider=twitter`;
        return res.redirect(client_redirect_uri);
      }
      const state = generators.state();
      const codeVerifier = generators.codeVerifier();
      const codeChallenge = generators.codeChallenge(codeVerifier);
      const url = client.authorizationUrl({
        redirect_uri: config.providers.twitter.callback_url,
        response_type: 'code',
        scope: 'tweet.read users.read offline.access',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      req.session.state = state;
      req.session.codeVerifier = codeVerifier;
      req.session.originalUrl = req.originalUrl;
      req.session.redirect_uri = redirect_uri;
      return res.redirect(url);
    })().catch(next);
  });

  router.get('/provider/twitter/cb', (req, res, next) => {
    (async () => {
      if (!req.session) {
        return res.status(403).send('NG');
      }
      const state = req.session.state;
      const codeVerifier = req.session.codeVerifier;
      const params = client.callbackParams(req);
      const token_set = await client.oauthCallback(
        config.providers.twitter.callback_url,
        params,
        { code_verifier: codeVerifier, state },
        { exchangeBody: { client_id: config.providers.twitter.client_id } }
      );
      req.session.token_set = token_set;
      if (typeof req.session.originalUrl != 'string') throw new Error('originalUrl must be a string');
      const token = await getTwiiterSessionToken(req.session.token_set);
      const client_redirect_uri = `${req.session.redirect_uri}?token=${token}&provider=twitter`;
      return res.redirect(client_redirect_uri);
    })().catch(next);
  });

  router.get('/provider/twitter/refresh', (req, res, next) => {
    (async () => {
      if (!req.session || !req.session.token_set || !req.session.token_set.refresh_token) {
        return res.status(403).send('NG');
      }
      const { data } = await axios.post<TokenSet>(
        'https://api.twitter.com/2/oauth2/token',
        {
          refresh_token: req.session.token_set.refresh_token,
          grant_type: 'refresh_token',
          client_id: config.providers.twitter.client_id,
        },
        {
          auth: {
            username: config.providers.twitter.client_id,
            password: config.providers.twitter.client_secret,
          },
        }
      );
      req.session.token_set = data;
      return res.send('OK!');
    })().catch(next);
  });

  router.get('/provider/twitter/revoke', (req, res, next) => {
    (async () => {
      if (!req.session.token_set) {
        return res.status(403).send('NG');
      }
      const { data } = await axios.post<RevocationResponse>(
        'https://api.twitter.com/2/oauth2/revoke',
        {
          token: req.session.token_set.access_token,
          client_id: config.providers.twitter.client_id,
          token_type_hint: 'access_token',
        },
        {
          auth: {
            username: config.providers.twitter.client_id,
            password: config.providers.twitter.client_secret,
          },
        }
      );
      if (data.revoked) {
        req.session.destroy((err) => {
          if (err) {
            throw err;
          }
        });
      }
      return res.send(data);
    })().catch(next);
  });
}

export default router;
// ref: https://github.com/kg0r0/twitter-oauth2-client
