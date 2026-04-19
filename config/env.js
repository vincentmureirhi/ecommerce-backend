'use strict';

function required(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5000),

  DB_HOST: required('DB_HOST'),
  DB_PORT: Number(process.env.DB_PORT || 5432),
  DB_NAME: required('DB_NAME'),
  DB_USER: required('DB_USER'),
  DB_PASSWORD: required('DB_PASSWORD'),
};

module.exports = env;